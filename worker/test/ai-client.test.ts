import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createCaller, UsageMeter } from '../src/ai/client.js';
import { EnrichmentSchema } from '../src/ai/schemas.js';
import { REGIONS } from '../src/domain.js';

const schema = z.object({ answer: z.number() });
const args = { schema, system: 'Extract an answer.', user: 'Answer: 42' };
const usage: Anthropic.Usage = {
  input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40,
  cache_creation: null, inference_geo: null, output_tokens_details: null,
  server_tool_use: null, service_tier: null, speed: null,
};
function fake(patch: { stop_reason?: Anthropic.Message['stop_reason']; parsed_output?: unknown } = {}) {
  const parse = vi.fn(async (_params: Anthropic.MessageCreateParamsNonStreaming) => ({
    stop_reason: 'end_turn' as const, parsed_output: { answer: 42 }, usage, ...patch,
  }));
  const meter = new UsageMeter();
  return { parse, meter, call: createCaller('fake-key', meter, { messages: { parse } }) };
}
afterEach(() => { vi.unstubAllGlobals(); });

describe('StructuredCaller', () => {
  it('returns parsed output and sends only the supported Haiku request shape', async () => {
    const { parse, meter, call } = fake();
    expect(await call(args)).toEqual({ answer: 42 });
    expect(parse.mock.calls[0][0]).toEqual({
      model: 'claude-haiku-5-5', max_tokens: 4000,
      system: [{ type: 'text', text: args.system, cache_control: { type: 'ephemeral' } }],
      output_config: { effort: 'low', format: expect.objectContaining({ type: 'json_schema' }) },
      messages: [{ role: 'user', content: args.user }],
    });
    for (const key of ['temperature', 'top_p', 'top_k', 'thinking']) {
      expect(parse.mock.calls[0][0]).not.toHaveProperty(key);
    }
    expect(meter).toMatchObject({ inputTokens: 100, outputTokens: 20, cacheWriteTokens: 30, cacheReadTokens: 40, failures: 0 });
    expect(meter.failureReasons).toEqual({});
  });
  it('honors maxTokens and supports another generic output type', async () => {
    const { parse, call } = fake({ parsed_output: { names: ['Ada'] } });
    const result = await call({ ...args, schema: z.object({ names: z.array(z.string()) }), maxTokens: 80 });
    expect(result?.names).toEqual(['Ada']);
    expect(parse.mock.calls[0][0].max_tokens).toBe(80);
  });
  it.each(['refusal', 'max_tokens'] as const)('discards %s even with parsed output, retaining billed usage', async (stop_reason) => {
    const { call, meter } = fake({ stop_reason });
    expect(await call(args)).toBeNull();
    expect(meter).toMatchObject({ failures: 1, inputTokens: 100, outputTokens: 20, cacheWriteTokens: 30, cacheReadTokens: 40 });
    expect(meter.failureReasons).toEqual({ [stop_reason]: 1 });
  });
  it('counts null parsed output as a failure', async () => {
    const { call, meter } = fake({ parsed_output: null });
    expect(await call(args)).toBeNull();
    expect(meter.failures).toBe(1);
    expect(meter.failureReasons).toEqual({ parsed_output_null: 1 });
  });
  it.each([
    [new Anthropic.AuthenticationError(401, {}, 'bad key', new Headers()), 'AuthenticationError:401'],
    [new Anthropic.NotFoundError(404, {}, 'bad model', new Headers()), 'NotFoundError:404'],
  ] as const)('rethrows the original typed configuration fault: %s', async (error, reason) => {
    const { call, parse, meter } = fake();
    parse.mockRejectedValueOnce(error);
    await expect(call(args)).rejects.toBe(error);
    expect(meter.failures).toBe(1);
    expect(meter.failureReasons).toEqual({ [reason]: 1 });
  });
  it.each([
    [new Anthropic.BadRequestError(400, {}, 'bad request', new Headers()), 'BadRequestError:400'],
    [new Anthropic.RateLimitError(429, {}, 'limited', new Headers()), 'RateLimitError:429'],
    [new Anthropic.InternalServerError(500, {}, 'server failure', new Headers()), 'InternalServerError:500'],
    [new Anthropic.APIConnectionError({ message: 'offline' }), 'APIConnectionError'],
    [new Anthropic.AnthropicError('Failed to parse structured output: invalid JSON'), 'AnthropicError'],
    [new Anthropic.AnthropicError('Failed to parse structured output: schema validation'), 'AnthropicError'],
  ] as const)('returns null and counts other exhausted SDK errors: %s', async (error, reason) => {
    const { call, parse, meter } = fake();
    parse.mockRejectedValueOnce(error);
    expect(await call(args)).toBeNull();
    expect(meter.failures).toBe(1);
    expect(meter.failureReasons).toEqual({ [reason]: 1 });
    expect(parse).toHaveBeenCalledTimes(1); // Retries belong to the SDK, not this wrapper.
  });
  it('aggregates repeat reasons and keeps meters independent', async () => {
    const { call, parse, meter } = fake({ stop_reason: 'refusal' });
    expect(await call(args)).toBeNull();
    expect(await call(args)).toBeNull();
    parse.mockRejectedValueOnce(new Anthropic.RateLimitError(429, {}, 'limited', new Headers()));
    expect(await call(args)).toBeNull();
    expect(meter.failureReasons).toEqual({ refusal: 2, 'RateLimitError:429': 1 });
    expect(meter.failures).toBe(3);
    expect(new UsageMeter().failureReasons).toEqual({});
  });
  it('records only bounded diagnostic categories, never error content, headers or secrets', async () => {
    const { call, parse, meter } = fake();
    const privateText = 'fixture-secret-and-private-request-content';
    const error = new Anthropic.BadRequestError(400, { message: privateText }, `${privateText}\n${'x'.repeat(1_000)}`,
      new Headers({ 'x-fixture-secret': privateText }));
    // Even an unexpected error subclass name is untrusted diagnostic text.
    Object.defineProperty(error, 'constructor', { value: { name: privateText } });
    parse.mockRejectedValueOnce(error);
    expect(await call(args)).toBeNull();
    parse.mockRejectedValueOnce(privateText);
    expect(await call(args)).toBeNull();
    expect(meter.failureReasons).toEqual({ 'BadRequestError:400': 1, UnknownError: 1 });
    expect(JSON.stringify(meter)).not.toContain(privateText);
    expect(Object.keys(meter.failureReasons).every((key) => key.length <= 64)).toBe(true);
    expect(meter.failures).toBe(2);
  });
  it('uses the actual SDK parser, default retries, and required outbound User-Agent', async () => {
    const requests: Request[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      if (requests.length < 3) return new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'retry' } }), {
        status: 429, headers: { 'content-type': 'application/json', 'retry-after-ms': '1' },
      });
      return new Response(JSON.stringify({ id: 'msg_fixture', type: 'message', role: 'assistant',
        model: 'claude-haiku-5-5', content: [{ type: 'text', text: '{"answer":42}', citations: null }],
        stop_reason: 'end_turn', stop_details: null, stop_sequence: null, usage,
      }), { headers: { 'content-type': 'application/json' } });
    });
    const meter = new UsageMeter();
    expect(await createCaller('fixture-only', meter)(args)).toEqual({ answer: 42 });
    expect(requests).toHaveLength(3);
    expect(requests.map((r) => r.headers.get('user-agent'))).toEqual(Array(3).fill('RematchBot/0.1 (+https://github.com/rematch-app)'));
    expect(meter.failures).toBe(0);
  });
});

describe('UsageMeter', () => {
  it('charges $0.60 for one million uncached input and output tokens', () => {
    const meter = new UsageMeter();
    meter.add({ input_tokens: 1_000_000, output_tokens: 1_000_000 });
    expect(meter.estCostUsd()).toBe(0.60);
  });
  it('accumulates caches separately and treats absent/null cache tokens as zero', () => {
    const meter = new UsageMeter();
    meter.add({ input_tokens: 1_000_000, output_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 });
    meter.add({ input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: null, cache_read_input_tokens: null });
    meter.add({ input_tokens: 30, output_tokens: 40 });
    expect(meter).toMatchObject({ inputTokens: 1_000_040, outputTokens: 1_000_060, cacheWriteTokens: 1_000_000, cacheReadTokens: 1_000_000 });
    expect(meter.estCostUsd()).toBeCloseTo(0.735034, 10);
    expect(new UsageMeter().estCostUsd()).toBe(0);
  });
});

describe('EnrichmentSchema', () => {
  const value = { is_remote: true, regions: ['europe'], countries: ['DE'], seniority: 'senior', role_family: 'backend',
    technologies: ['TypeScript'], salary_usd_year_min: null, salary_usd_year_max: null, company_size: null, summary: 'Build APIs.' };
  it('accepts the shared regions, country-only eligibility, and unknown fields', () => {
    expect(EnrichmentSchema.parse({ ...value, regions: [...REGIONS] }).regions).toEqual(REGIONS);
    expect(EnrichmentSchema.parse({ ...value, regions: [], countries: ['US'] }).regions).toEqual([]);
    expect(EnrichmentSchema.parse({ ...value, regions: [], countries: [], seniority: 'unknown', role_family: 'other', summary: 'x'.repeat(160) }).summary).toHaveLength(160);
  });
  it.each([
    { regions: ['mars'] }, { countries: ['USA'] }, { countries: ['us'] }, { seniority: 42 },
    { role_family: {} }, { summary: 42 }, { is_remote: 'yes' },
  ])('rejects invalid enrichment: %j', (patch) => {
    expect(EnrichmentSchema.safeParse({ ...value, ...patch }).success).toBe(false);
  });
});
