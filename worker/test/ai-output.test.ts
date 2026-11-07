import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { deepEqual } from 'node:assert/strict';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import { createCaller, UsageMeter } from '../src/ai/client.js';
import { ConstraintsSchema, EnrichmentSchema, ScoreBatchSchema, type Enrichment, type RoleFamily, type Seniority } from '../src/ai/schemas.js';

const value = { is_remote: true, regions: ['europe'], countries: [], seniority: 'senior', role_family: 'backend',
  technologies: ['TypeScript'], salary_usd_year_min: null, salary_usd_year_max: null, company_size: null,
  summary: 'Build APIs.' };

function sdkCall(content: string) {
  const meter = new UsageMeter();
  const sdk = new Anthropic({ apiKey: 'fixture-only', fetch: async () => new Response(JSON.stringify({
    id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-haiku-5-5',
    content: [{ type: 'text', text: content, citations: null }], stop_reason: 'end_turn',
    stop_details: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20 },
  }), { headers: { 'content-type': 'application/json' } }) });
  return { meter, call: createCaller('fixture-only', meter, sdk) };
}
const args = { schema: EnrichmentSchema, system: 'Extract factual enrichment.', user: 'Fixture listing.' };

describe('real SDK output regression', () => {
  it.each([
    [{ role_family: 'sales' }, { role_family: 'other' }],
    [{ role_family: 'marketing' }, { role_family: 'other' }],
    [{ seniority: 'manager' }, { seniority: 'unknown' }],
    [{ role_family: 'finance', seniority: 'executive' }, { role_family: 'other', seniority: 'unknown' }],
    [{ role_family: '', seniority: '' }, { role_family: 'other', seniority: 'unknown' }],
  ])('maps out-of-enum strings to enrichment fallbacks: %j', async (patch, expected) => {
    const { call, meter } = sdkCall(JSON.stringify({ ...value, ...patch }));
    const result = await call(args);
    expect(result).toEqual({ ...value, ...expected });
    expect(EnrichmentSchema.parse(result)).toEqual(result);
    expect(meter.failures).toBe(0);
    expect(meter.inputTokens).toBe(100);
  });

  it.each([
    ['role_family', ['frontend', 'backend', 'fullstack', 'mobile', 'devops', 'data', 'ml', 'design', 'product', 'qa', 'security', 'other']],
    ['seniority', ['intern', 'junior', 'mid', 'senior', 'staff', 'principal', 'lead', 'unknown']],
  ] as const)('preserves every valid %s label', async (field, labels) => {
    for (const label of labels) {
      const input = { ...value, [field]: label };
      const { call } = sdkCall(JSON.stringify(input));
      expect(await call(args)).toEqual(input);
    }
  });

  it('preserves the outbound enum schema byte-for-byte and exact exported types', () => {
    const strictSchema = EnrichmentSchema.extend({
      seniority: z.enum(['intern', 'junior', 'mid', 'senior', 'staff', 'principal', 'lead', 'unknown']),
      role_family: z.enum(['frontend', 'backend', 'fullstack', 'mobile', 'devops', 'data', 'ml', 'design', 'product', 'qa', 'security', 'other']),
    });
    const before = zodOutputFormat(strictSchema).schema;
    const after = zodOutputFormat(EnrichmentSchema).schema;
    deepEqual(after, before);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    expectTypeOf<Enrichment>().toEqualTypeOf<z.infer<typeof strictSchema>>();
    expectTypeOf<Seniority>().toEqualTypeOf<z.infer<typeof strictSchema>['seniority']>();
    expectTypeOf<RoleFamily>().toEqualTypeOf<z.infer<typeof strictSchema>['role_family']>();
  });

  it.each([
    { role_families: ['sales'] },
    { role_families: ['marketing'] },
    { seniority_allowed: ['manager'] },
  ])('keeps subscriber constraints strict: %j', async (patch) => {
    const { call } = sdkCall(JSON.stringify({ salary_floor_usd_year: null, seniority_allowed: ['senior'],
      role_families: ['backend'], country: 'DE', regions: ['europe'], ...patch }));
    expect(await call({ ...args, schema: ConstraintsSchema })).toBeNull();
  });

  // The 20-job live sample failed only summary.max(160), with these lengths.
  // Preserve the failing shapes without retaining listing/model content in tests.
  it.each([162, 192, 191, 197, 169, 167, 179, 181, 178, 172])('accepts a %i-character summary and returns the original 160-character contract', async (length) => {
    const { call, meter } = sdkCall(JSON.stringify({ ...value, summary: 'x'.repeat(length) }));
    const result = await call(args);
    expect(result).toEqual({ ...value, summary: 'x'.repeat(160) });
    expect(meter.failures).toBe(0);
    expect(meter.inputTokens).toBe(100);
  });

  it.each([
    ['  Build APIs.  ', 'Build APIs.'],
    ['a'.repeat(159) + '🚀tail', 'a'.repeat(159)],
    ['a'.repeat(158) + '🚀tail', 'a'.repeat(158) + '🚀'],
    [' '.repeat(200), ''],
  ])('normalizes summary whitespace and truncates without a broken surrogate', async (summary, expected) => {
    const { call } = sdkCall(JSON.stringify({ ...value, summary }));
    const result = await call(args);
    expect(result).toEqual({ ...value, summary: expected });
    expect(EnrichmentSchema.parse(result)).toEqual(result); // Existing caller validates SDK output again.
  });

  it.each([
    [{ summary: 42 }, 'summary'],
    [{ countries: ['PRIVATE_INVALID_COUNTRY'] }, 'countries'],
    [{ regions: ['PRIVATE_INVALID_REGION'] }, 'regions'],
    ...[42, null, true, {}, [], undefined].flatMap((invalid) => [
      [{ seniority: invalid }, 'seniority'],
      [{ role_family: invalid }, 'role_family'],
    ] as const),
    [{ salary_usd_year_min: -1 }, 'salary_usd_year_min'],
    [{ company_size: 1.5 }, 'company_size'],
  ] as const)('retains strict validation and diagnoses only a fixed field for %j', async (patch, field) => {
    const { call, meter } = sdkCall(JSON.stringify({ ...value, ...patch }));
    expect(await call(args)).toBeNull();
    expect(meter.failureReasons).toEqual({ [`AnthropicError.output_validation:${field}`]: 1 });
    expect(meter.failures).toBe(1);
    expect(JSON.stringify(meter)).not.toContain('PRIVATE');
  });

  it('classifies JSON syntax errors without including any model output', async () => {
    const { call, meter } = sdkCall('{"summary":"PRIVATE_TRUNCATED_OUTPUT');
    expect(await call(args)).toBeNull();
    expect(meter.failureReasons).toEqual({ 'AnthropicError.output_parse': 1 });
    expect(JSON.stringify(meter)).not.toContain('PRIVATE');
  });

  it('never copies a path the called schema does not declare into diagnostic keys', async () => {
    const { call, meter } = sdkCall('{"known":1,"PRIVATE_FIELD":"PRIVATE_VALUE"}');
    expect(await call({ ...args, schema: z.strictObject({ known: z.number() }) })).toBeNull();
    expect(meter.failureReasons).toEqual({ 'AnthropicError.output_validation:unknown': 1 });
    expect(JSON.stringify(meter)).not.toContain('PRIVATE');
  });

  it.each([
    [ConstraintsSchema, { regions: ['PRIVATE_REGION'], country: 'RS', salary_floor_usd_year: null, seniority_allowed: [], role_families: [] }, 'regions'],
    [ConstraintsSchema, { regions: [], country: 42, salary_floor_usd_year: null, seniority_allowed: [], role_families: [] }, 'country'],
    [ScoreBatchSchema, { results: 'PRIVATE_RESULTS' }, 'results'],
  ] as [z.ZodType, unknown, string][])("labels failures with the called schema's own field (%#)", async (schema, output, field) => {
    const { call, meter } = sdkCall(JSON.stringify(output));
    expect(await call({ ...args, schema })).toBeNull();
    expect(meter.failureReasons).toEqual({ [`AnthropicError.output_validation:${field}`]: 1 });
    expect(JSON.stringify(meter)).not.toContain('PRIVATE');
  });

  it('keeps concurrent output diagnostics local to each call', async () => {
    const meter = new UsageMeter();
    const sdk = new Anthropic({ apiKey: 'fixture-only', fetch: async (input, init) => {
      const request = await new Request(input, init).json();
      const content = request.messages[0].content === 'syntax' ? 'PRIVATE_INVALID_JSON'
        : JSON.stringify({ ...value, countries: ['PRIVATE_INVALID_COUNTRY'] });
      return new Response(JSON.stringify({ id: 'msg_fixture', type: 'message', role: 'assistant',
        model: 'claude-haiku-5-5', content: [{ type: 'text', text: content, citations: null }],
        stop_reason: 'end_turn', stop_details: null, stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 20 },
      }), { headers: { 'content-type': 'application/json' } });
    } });
    const call = createCaller('fixture-only', meter, sdk);
    expect(await Promise.all([call({ ...args, user: 'syntax' }), call(args)])).toEqual([null, null]);
    expect(meter.failureReasons).toEqual({ 'AnthropicError.output_parse': 1, 'AnthropicError.output_validation:countries': 1 });
    expect(meter.failures).toBe(2);
  });
});
