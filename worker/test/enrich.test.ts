import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../src/db.types.js';
import { createCaller, UsageMeter, type StructuredCaller } from '../src/ai/client.js';
import { EnrichmentSchema, type Enrichment } from '../src/ai/schemas.js';
import { enrich } from '../src/pipeline/enrich.js';
import { freshnessFilter, normalizeStructuredSalary } from '../src/pipeline/job-rules.js';
import { createRunLog } from '../src/pipeline/runlog.js';
import { resetDb, testDb } from './helpers/db.js';

const now = new Date('2026-11-06T12:00:00Z');
const boundary = '2026-10-23T12:00:00Z';
const old = '2026-10-17T12:00:00Z';
const output: Enrichment = {
  is_remote: true, regions: ['europe'], countries: [], seniority: 'senior', role_family: 'backend',
  technologies: ['TypeScript'], salary_usd_year_min: 90_000, salary_usd_year_max: 110_000,
  company_size: 40, summary: 'Build remote APIs.',
};
type JobInsert = Database['public']['Tables']['jobs']['Insert'];
type Salary = Pick<JobInsert, 'salary_min' | 'salary_max' | 'salary_currency' | 'salary_period'>;
const absent = { salary_min: null, salary_max: null, salary_currency: null, salary_period: null };
let db: ReturnType<typeof testDb>;
async function job(patch: Partial<JobInsert> = {}) {
  const result = await db.from('jobs').insert({ dedupe_key: randomUUID(), title: 'Engineer', company: 'Acme',
    description: 'Remote from Europe. Build APIs.', location_text: 'Europe', first_seen_at: now.toISOString(), ...patch,
  }).select().single();
  expect(result.error).toBeNull();
  return result.data!;
}
async function company() {
  const result = await db.from('companies').insert({ name: 'Acme', ats: 'ashby', slug: randomUUID(), discovered_via: 'fixture' }).select().single();
  expect(result.error).toBeNull();
  return result.data!;
}
function caller(result: Enrichment | null = output): StructuredCaller {
  return async ({ schema }) => result === null ? null : schema.parse(result);
}
async function stored() {
  const result = await db.from('job_enrichment').select().order('job_id');
  expect(result.error).toBeNull();
  return result.data!;
}

describe('shared salary normalization', () => {
  it.each([
    ['EUR', 'year', 75_000, 100_000, 81_000, 108_000],
    [' eur ', 'year', 75_000, 100_000, 81_000, 108_000],
    ['USD', 'month', 5_000, 6_000, 60_000, 72_000],
    ['GBP', 'hour', 50, null, 132_080, null],
    ['CAD', 'year', null, 100_000, null, 73_000],
    ['AUD', 'year', 100_000, 120_000, 66_000, 79_200],
    ['CHF', 'year', 75_000, 100_000, 84_000, 112_000],
    ['USD', 'year', 0, 75_000.6, 0, 75_001],
    ['XXX', 'year', 75_000, 100_000, null, null],
    ['USD', 'week', 5_000, 6_000, null, null],
    [null, 'year', 75_000, null, null, null],
    ['EUR', null, 75_000, null, null, null],
    ['EUR', 'year', null, null, null, null],
  ])('normalizes %s/%s with nullable bounds', (currency, period, min, max, wantMin, wantMax) => {
    expect(normalizeStructuredSalary({ salary_currency: currency as string | null, salary_period: period as string | null,
      salary_min: min as number | null, salary_max: max as number | null,
    })).toEqual({ salary_usd_year_min: wantMin, salary_usd_year_max: wantMax });
  });
  it.each([
    ['PLN', 25_400],
    ['INR', 1_060],
    ['SEK', 10_100],
    ['NOK', 10_600],
    ['DKK', 14_900],
    ['CZK', 4_590],
    ['HUF', 307],
    ['RON', 20_900],
    ['BRL', 18_200],
    ['MXN', 5_350],
    ['JPY', 632],
    ['SGD', 78_000],
    ['NZD', 55_400],
    ['ILS', 31_300],
  ])('converts common %s salaries before enforcing a floor', (currency, want) => {
    expect(normalizeStructuredSalary({ salary_currency: currency as string, salary_period: 'year',
      salary_min: null, salary_max: 100_000,
    })).toEqual({ salary_usd_year_min: null, salary_usd_year_max: want });
  });
  it('distinguishes absent structured salary from an unconvertible structured salary', () => {
    expect(normalizeStructuredSalary(absent)).toBeNull();
  });
});

describe('enrich selection and persistence', () => {
  beforeAll(() => { db = testDb(); });
  beforeEach(async () => { await resetDb(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  it.each(['sales', 'marketing'])('persists fallback enums from a real SDK response with role_family %s and seniority manager', async (role_family) => {
    const listing = await job();
    const sdk = new Anthropic({ apiKey: 'fixture-only', fetch: async () => new Response(JSON.stringify({
      id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-haiku-5-5',
      content: [{ type: 'text', text: JSON.stringify({ ...output, role_family, seniority: 'manager' }), citations: null }],
      stop_reason: 'end_turn', stop_details: null, stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 20 },
    }), { headers: { 'content-type': 'application/json' } }) });
    const meter = new UsageMeter();
    const log = createRunLog();
    await enrich(db, log, createCaller('fixture-only', meter, sdk));
    expect(await stored()).toEqual([expect.objectContaining({ ...output, job_id: listing.id, role_family: 'other', seniority: 'unknown' })]);
    expect(log.stats).toMatchObject({ 'enrich.selected': 1, 'enrich.enriched': 1, 'enrich.failed': 0 });
    expect(log.errors).toEqual([]);
    expect(meter.failures).toBe(0);
  });
  it('persists enrichment from a real SDK response with the live overlong-summary failure shape', async () => {
    const listing = await job();
    const sdk = new Anthropic({ apiKey: 'fixture-only', fetch: async () => new Response(JSON.stringify({
      id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-haiku-5-5',
      content: [{ type: 'text', text: JSON.stringify({ ...output, summary: 'x'.repeat(197) }), citations: null }],
      stop_reason: 'end_turn', stop_details: null, stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 20 },
    }), { headers: { 'content-type': 'application/json' } }) });
    const meter = new UsageMeter();
    const log = createRunLog();
    await enrich(db, log, createCaller('fixture-only', meter, sdk));
    expect(await stored()).toEqual([expect.objectContaining({ ...output, job_id: listing.id, summary: 'x'.repeat(160) })]);
    expect(log.stats).toMatchObject({ 'enrich.enriched': 1, 'enrich.failed': 0 });
    expect(log.errors).toEqual([]);
    expect(meter.failures).toBe(0);
  });
  it('uses the shared inclusive coalesce window, skips closed/old/enriched rows, and is idempotent', async () => {
    const posted = await job({ posted_at: boundary, first_seen_at: old });
    const fallback = await job({ posted_at: null, first_seen_at: boundary });
    const recent = await job({ posted_at: now.toISOString() });
    await job({ posted_at: old }); // A new first_seen_at must not rescue an old posted_at.
    await job({ posted_at: null, first_seen_at: old });
    await job({ posted_at: '2026-10-23T11:59:59.999Z' });
    await job({ posted_at: null, first_seen_at: '2026-10-23T11:59:59.999Z' });
    await job({ status: 'closed' });
    const existing = await job();
    expect((await db.from('job_enrichment').insert({ ...output, job_id: existing.id, summary: 'Preserve me.' })).error).toBeNull();
    const selected = await db.from('jobs').select('id').or(freshnessFilter(now));
    expect(selected.error).toBeNull();
    expect(selected.data!.map((j) => j.id)).toEqual(expect.arrayContaining([posted.id, fallback.id, recent.id]));
    const log = createRunLog();
    await enrich(db, log, caller());
    expect((await stored()).map((j) => j.job_id).sort()).toEqual([posted.id, fallback.id, recent.id, existing.id].sort());
    expect((await stored()).find((j) => j.job_id === existing.id)?.summary).toBe('Preserve me.');
    expect((await stored()).find((j) => j.job_id === recent.id)).toMatchObject(output);
    expect(log.stats).toMatchObject({ 'enrich.selected': 3, 'enrich.enriched': 3, 'enrich.failed': 0 });
    const again = createRunLog();
    await enrich(db, again, async () => { throw new Error('Must not call AI twice'); });
    expect(again.stats).toMatchObject({ 'enrich.selected': 0, 'enrich.enriched': 0, 'enrich.failed': 0 });
    expect(again.errors).toEqual([]);
  });
  it('passes raw listing data and contradictory hints with source provenance', async () => {
    const row = await job({ salary_min: 75_000, salary_max: null, salary_currency: 'EUR', salary_period: 'year' });
    expect((await db.from('job_sources').insert([
      { job_id: row.id, source: 'ashby', external_id: 'a', url: 'https://example.test/a', remote_hint: false },
      { job_id: row.id, source: 'jobicy', external_id: 'b', url: 'https://example.test/b', remote_hint: true },
      { job_id: row.id, source: 'wwr', external_id: 'c', url: 'https://example.test/c', remote_hint: null },
    ])).error).toBeNull();
    const call: StructuredCaller = async ({ schema, user }) => {
      expect(schema).toBe(EnrichmentSchema);
      const evidence = JSON.parse(user);
      expect(evidence).toMatchObject({ title: 'Engineer', company: 'Acme', locationText: 'Europe',
        description: row.description, salary: { min: 75_000, max: null, currency: 'EUR', period: 'year' } });
      expect(evidence.remoteHint).toHaveLength(3);
      expect(evidence.remoteHint).toEqual(expect.arrayContaining([
        { source: 'ashby', remoteHint: false }, { source: 'jobicy', remoteHint: true }, { source: 'wwr', remoteHint: null },
      ]));
      return schema.parse({ ...output, is_remote: false });
    };
    const log = createRunLog();
    await enrich(db, log, call);
    expect(log.errors).toEqual([]);
    expect(await stored()).toMatchObject([{ is_remote: false, salary_usd_year_min: 81_000, salary_usd_year_max: null }]);
  });
  it.each([
    [{ salary_min: 75_000, salary_currency: 'EUR', salary_period: 'year' }, 81_000, null],
    [{ salary_min: 75_000, salary_currency: 'XXX', salary_period: 'year' }, null, null],
    [{ salary_min: 75_000, salary_currency: 'USD', salary_period: null }, null, null],
    [{ salary_currency: 'USD', salary_period: 'year' }, null, null],
    [{}, 90_000, 110_000],
  ] satisfies [Salary, number | null, number | null][])('gives structured salary precedence and retains description-only salary: %j', async (salary, min, max) => {
    await job(salary);
    const log = createRunLog();
    await enrich(db, log, caller());
    expect(log.errors).toEqual([]);
    expect(await stored()).toMatchObject([{ salary_usd_year_min: min, salary_usd_year_max: max }]);
  });
  it('updates only the company of an actually remote enriched ATS job', async () => {
    const remote = await company();
    const hybrid = await company();
    await job({ company_id: remote.id, title: 'Remote' });
    await job({ company_id: hybrid.id, title: 'Hybrid' });
    await job({ title: 'Board-only' });
    const log = createRunLog();
    await enrich(db, log, async ({ schema, user }) => schema.parse({ ...output, is_remote: JSON.parse(user).title !== 'Hybrid' }));
    const companies = await db.from('companies').select().order('id');
    expect(companies.error).toBeNull();
    expect(new Date(companies.data!.find((c) => c.id === remote.id)!.last_remote_job_at!).toISOString()).toBe(now.toISOString());
    expect(companies.data!.find((c) => c.id === hybrid.id)!.last_remote_job_at).toBeNull();
    expect(log.errors).toEqual([]);
    expect(await stored()).toHaveLength(3);
  });
  it('leaves enrichment retryable when the company timestamp update fails', async () => {
    const co = await company();
    const row = await job({ company_id: co.id });
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method === 'PATCH' && new URL(request.url).pathname === '/rest/v1/companies') {
        return Promise.resolve(new Response(JSON.stringify({ code: 'XX000', message: 'fixture company write failure', details: null, hint: null }), {
          status: 500, headers: { 'content-type': 'application/json' },
        }));
      }
      return realFetch(input, init);
    });
    const log = createRunLog();
    await enrich(testDb(), log, caller());
    expect(await stored()).toEqual([]);
    expect(log.errors).toEqual([{ stage: 'enrich', message: `${row.id}: fixture company write failure` }]);
    expect(log.stats).toMatchObject({ 'enrich.selected': 1, 'enrich.enriched': 0, 'enrich.failed': 1 });
    vi.unstubAllGlobals();
    await enrich(db, createRunLog(), caller());
    expect(await stored()).toMatchObject([{ job_id: row.id, is_remote: true }]);
  });
  it('leaves null results retryable, logs the exact job id, and processes other jobs', async () => {
    const failed = await job({ title: 'Retry me' });
    await job({ title: 'Succeed' });
    const log = createRunLog();
    await enrich(db, log, async ({ schema, user }) => JSON.parse(user).title === 'Retry me' ? null : schema.parse(output));
    expect(log.errors).toEqual([{ stage: 'enrich', message: failed.id }]);
    expect(log.stats).toMatchObject({ 'enrich.selected': 2, 'enrich.enriched': 1, 'enrich.failed': 1 });
    expect(await stored()).toHaveLength(1);
    await enrich(db, createRunLog(), caller());
    expect(await stored()).toHaveLength(2);
  });
  it('keeps country-only eligibility without inferring a broader region', async () => {
    await job();
    await enrich(db, createRunLog(), caller({ ...output, regions: [], countries: ['US'] }));
    expect(await stored()).toMatchObject([{ regions: [], countries: ['US'] }]);
  });
  it('bounds concurrent callers at five and reuses the same system text for all jobs', async () => {
    for (let i = 0; i < 12; i++) await job({ title: `Job ${i}` });
    let active = 0;
    let peak = 0;
    const systems = new Set<string>();
    await enrich(db, createRunLog(), async ({ schema, system }) => {
      systems.add(system);
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return schema.parse(output);
    });
    expect(peak).toBe(5);
    expect(systems.size).toBe(1);
    expect(await stored()).toHaveLength(12);
  });
  it.each([
    new Anthropic.AuthenticationError(401, {}, 'bad key', new Headers()),
    new Anthropic.NotFoundError(404, {}, 'bad model', new Headers()),
  ])('stops queued jobs and drains in-flight work before propagating a config fault: %s', async (error) => {
    for (let i = 0; i < 12; i++) await job();
    let calls = 0;
    let settled = 0;
    const log = createRunLog();
    const running = enrich(db, log, async ({ schema }) => {
      const index = calls++;
      if (index === 0) throw error;
      await new Promise((resolve) => setTimeout(resolve, 15));
      settled++;
      return schema.parse(output);
    });
    await expect(running).rejects.toBe(error);
    expect(calls).toBeLessThanOrEqual(5);
    expect(settled).toBe(calls - 1);
    expect(await stored()).toHaveLength(settled);
    expect(log.errors).toEqual([]);
  });
  it('does not lose eligible jobs beyond the API row cap while inserting enrichment', async () => {
    for (let offset = 0; offset < 1_001; offset += 200) {
      const batch = Array.from({ length: Math.min(200, 1_001 - offset) }, (_, i) => ({ dedupe_key: `page-${offset + i}`,
        title: `Job ${offset + i}`, company: 'Acme', description: 'Remote', first_seen_at: now.toISOString() }));
      expect((await db.from('jobs').insert(batch)).error).toBeNull();
    }
    const log = createRunLog();
    await enrich(db, log, caller());
    const result = await db.from('job_enrichment').select('job_id', { count: 'exact', head: true });
    expect(result.error).toBeNull();
    expect(result.count).toBe(1_001);
    expect(log.stats).toMatchObject({ 'enrich.selected': 1_001, 'enrich.enriched': 1_001, 'enrich.failed': 0 });
    expect(log.errors).toEqual([]);
  }, 30_000);
});
