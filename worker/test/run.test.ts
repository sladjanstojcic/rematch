import Anthropic from '@anthropic-ai/sdk';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ownedLocalConnection } from '../../supabase/local-db.mjs';
import { UsageMeter, type StructuredCaller } from '../src/ai/client.js';
import { ConstraintsSchema, EnrichmentSchema, ScoreBatchSchema } from '../src/ai/schemas.js';
import { loadConfig, type Config } from '../src/config.js';
import type { AtsName, RawJob } from '../src/domain.js';
import type { Mailer } from '../src/email/smtp.js';
import * as collecting from '../src/pipeline/collect.js';
import * as enriching from '../src/pipeline/enrich.js';
import * as prompts from '../src/pipeline/prompts.js';
import * as scoring from '../src/pipeline/score.js';
import * as digesting from '../src/pipeline/digest.js';
import { runOnce } from '../src/pipeline/run.js';
import type { AtsAdapter, BoardAdapter } from '../src/sources/types.js';
import { resetDb, testDb, withTestSql } from './helpers/db.js';

const now = new Date('2026-11-06T23:30:00Z'); // Belgrade is already November 7.
const listing = 'https://boards.greenhouse.io/acme/jobs/42';
let db: ReturnType<typeof testDb>;
let cfg: Config;
const constraints = { country: 'RS', regions: ['europe', 'emea'], salary_floor_usd_year: 80_000,
  seniority_allowed: ['mid', 'senior'], role_families: ['frontend'] };

function raw(us = false): RawJob {
  return { source: 'greenhouse', externalId: us ? '43' : '42', url: us ? `${listing}3` : listing,
    title: us ? 'US-only React Engineer' : 'EMEA React Engineer', company: 'Acme',
    locationText: us ? 'US' : 'EMEA', salary: { min: 90_000, max: 110_000, currency: 'USD', period: 'year' },
    descriptionText: 'Remote React frontend with UI and UX.', postedAt: now, applyUrl: null, remoteHint: true };
}

function fakeCaller(): StructuredCaller {
  return async ({ schema, user }) => {
    if (Object.is(schema, EnrichmentSchema)) {
      const us = JSON.parse(user).locationText === 'US';
      return schema.parse({ is_remote: true, regions: us ? [] : ['emea'], countries: us ? ['US'] : [],
        seniority: 'senior', role_family: 'frontend', technologies: ['React'],
        salary_usd_year_min: 90_000, salary_usd_year_max: 110_000, company_size: null, summary: 'Build React UI.' });
    }
    if (Object.is(schema, ConstraintsSchema)) return schema.parse(constraints);
    if (Object.is(schema, ScoreBatchSchema)) return schema.parse({ results: JSON.parse(user).jobs.map((j: { id: string }) =>
      ({ job_id: j.id, score: 90, reason: 'React frontend in EMEA above your salary floor.' })) });
    throw new Error('Unexpected schema');
  };
}

function dependencies() {
  const sent: Parameters<Mailer>[0][] = [];
  const meter = new UsageMeter();
  meter.add({ input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 300, cache_read_input_tokens: 400 });
  const adapter = (ats: AtsName): AtsAdapter => ({ ats,
    fetchCompany: async (slug) => slug === 'acme' ? [raw(), raw(true)] : [] });
  const ats = { ashby: adapter('ashby'), greenhouse: adapter('greenhouse'), lever: adapter('lever'), recruitee: adapter('recruitee') };
  const mailer: Mailer = async (msg) => { sent.push(msg); };
  return { db, cfg, now, meter, call: fakeCaller(), mailer, boards: [] as BoardAdapter[], ats, sent };
}

async function seed() {
  expect((await db.from('companies').insert({ name: 'Acme', ats: 'greenhouse', slug: 'acme', discovered_via: 'fixture' })).error).toBeNull();
  expect((await db.from('subscribers').insert({ email: 'reader@example.test', name: null,
    location: 'Serbia', prompt: 'React frontend, mid to senior, above USD 80000/year.' })).error).toBeNull();
}

async function storedRun(id: string | null) {
  expect(id).not.toBeNull();
  const result = await db.from('runs').select().eq('id', id!).single();
  expect(result.error).toBeNull();
  return result.data!;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('runOnce with owned local DB and fake external services', () => {
  beforeAll(() => {
    db = testDb();
    const local = ownedLocalConnection();
    cfg = loadConfig({ SUPABASE_URL: local.apiUrl, SUPABASE_SERVICE_ROLE_KEY: local.serviceRoleKey,
      DATABASE_URL: local.databaseUrl, ANTHROPIC_API_KEY: 'fixture', OWNER_EMAIL: 'owner@example.test', TZ: 'Europe/Belgrade' });
  });
  beforeEach(async () => { await resetDb(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now); });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('runs the real stages, sends only the EMEA job with ATS credit, and persists usage and local day', async () => {
    await seed();
    const deps = dependencies();
    const result = await runOnce(deps);
    expect(result.status).toBe('ok');
    expect(deps.sent).toHaveLength(1);
    expect(deps.sent[0].text).toContain(listing);
    expect(deps.sent[0].text).toContain('Greenhouse');
    expect(deps.sent[0].text).not.toContain('US-only');
    expect(deps.sent[0].headers).toEqual({ 'List-Unsubscribe': '<mailto:owner@example.test?subject=STOP>', 'Reply-To': 'owner@example.test' });
    const row = await storedRun(result.runId);
    expect(row).toMatchObject({ status: 'ok', errors: [], input_tokens: 1700, output_tokens: 200, est_cost_usd: 0.0002415,
      stats: { collect_upserted: 2, 'enrich.enriched': 2, 'prompts.refreshed': 1,
        'score.candidates': 1, 'score.matched': 1, 'digest.sent': 1, 'digest.items': 1, 'ai.failures': 0 } });
    expect(Date.parse(row.started_at)).toBe(now.getTime());
    expect(Date.parse(row.finished_at!)).toBeGreaterThanOrEqual(now.getTime());
    const subscriber = await db.from('subscribers').select('last_digest_on').single();
    expect(subscriber.error).toBeNull();
    expect(subscriber.data!.last_digest_on).toBe('2026-11-07');
  });

  it('does not resend on the next run and starts a fresh RunLog', async () => {
    await seed();
    const deps = dependencies();
    expect((await runOnce(deps)).status).toBe('ok');
    const again = await runOnce(deps);
    expect(again.status).toBe('ok');
    expect(deps.sent).toHaveLength(1);
    expect((await storedRun(again.runId)).stats).toMatchObject({ 'enrich.enriched': 0, 'score.scored': 0, 'digest.sent': 0 });
  });

  it('records an item-level board failure as partial and still sends the digest', async () => {
    await seed();
    const deps = dependencies();
    deps.boards = [{ name: 'wwr', fetchJobs: async () => { throw new Error('fixture unavailable'); } }];
    deps.meter.addFailure('refusal'); deps.meter.addFailure('refusal'); deps.meter.addFailure('parsed_output_null');
    const result = await runOnce(deps);
    expect(result.status).toBe('partial');
    expect(deps.sent).toHaveLength(1);
    expect(await storedRun(result.runId)).toMatchObject({ status: 'partial',
      errors: [{ stage: 'collect', source: 'wwr', message: 'fixture unavailable' }],
      stats: { 'ai.failures': 3, 'ai.failureReasons.refusal': 2, 'ai.failureReasons.parsed_output_null': 1 } });
  });

  it('skips a concurrent run before creating a row or entering any stage, and releases the session afterwards', async () => {
    await seed();
    const deps = dependencies();
    const entered = deferred();
    const release = deferred();
    deps.boards = [{ name: 'wwr', fetchJobs: async () => { entered.resolve(); await release.promise; return []; } }];
    const first = runOnce(deps);
    // A no-op implementation must fail here instead of leaving the test waiting forever.
    await Promise.race([entered.promise, first.then(() => { throw new Error('First run never entered collect'); })]);
    try {
      const second = dependencies();
      second.boards = [{ name: 'wwr', fetchJobs: async () => { throw new Error('Skipped run entered collect'); } }];
      expect(await runOnce(second)).toEqual({ runId: null, status: 'skipped' });
      expect(second.sent).toEqual([]);
      const rows = await db.from('runs').select('id');
      expect(rows.error).toBeNull(); expect(rows.data).toHaveLength(1);
    } finally { release.resolve(); await first; }
    expect(deps.sent).toHaveLength(1);
    expect((await runOnce(dependencies())).status).toBe('ok');
    await withTestSql(async (sql) => {
      const locks = await sql`select count(*)::int as count from pg_locks where locktype = 'advisory' and database = (select oid from pg_database where datname = current_database())`;
      expect(locks[0].count).toBe(0);
    });
  });

  it.each(['collect', 'enrich', 'refreshPrompts', 'score', 'sendDigests'] as const)(
    'isolates a thrown %s stage, persists a private failure, and continues permitted stages', async (stage) => {
      await seed();
      const deps = dependencies();
      const spies = { collect: vi.spyOn(collecting, 'collect'), enrich: vi.spyOn(enriching, 'enrich'),
        refreshPrompts: vi.spyOn(prompts, 'refreshPrompts'), score: vi.spyOn(scoring, 'score'), sendDigests: vi.spyOn(digesting, 'sendDigests') };
      spies[stage].mockRejectedValueOnce(new Error('private prompt reader@example.test sk-secret'));
      const result = await runOnce(deps);
      expect(result.status).toBe('failed');
      const row = await storedRun(result.runId);
      expect(row.errors).toEqual(expect.arrayContaining([{ stage, message: expect.any(String) }]));
      expect(JSON.stringify(row.errors)).not.toMatch(/private prompt|reader@example|sk-secret/);
      expect(row.finished_at).not.toBeNull();
      expect(row.stats).toMatchObject({ 'companies.deactivated': 0 });
      expect(spies.refreshPrompts).toHaveBeenCalledOnce();
      expect(spies.score).toHaveBeenCalledTimes(stage === 'refreshPrompts' ? 0 : 1);
      expect(spies.sendDigests).toHaveBeenCalledTimes(['refreshPrompts', 'score'].includes(stage) ? 0 : 1);
      vi.restoreAllMocks();
      expect((await runOnce(dependencies())).status).toBe('ok');
    });

  it.each(['refreshPrompts', 'score'] as const)('does not send after a real AI config fault in %s', async (stage) => {
    await seed();
    const deps = dependencies();
    const good = deps.call;
    deps.call = async (args) => {
      if (Object.is(args.schema, stage === 'refreshPrompts' ? ConstraintsSchema : ScoreBatchSchema)) {
        throw new Anthropic.AuthenticationError(401, { message: 'private prompt sk-secret' }, 'private prompt', new Headers());
      }
      return good(args);
    };
    const result = await runOnce(deps);
    expect(result.status).toBe('failed'); expect(deps.sent).toEqual([]);
    const row = await storedRun(result.runId);
    expect(row.errors).toEqual(expect.arrayContaining([{ stage, message: expect.any(String) }]));
    expect(JSON.stringify(row.errors)).not.toMatch(/private prompt|sk-secret/);
  });

  it('deactivates strictly older than 60 days with created_at grace, without closing jobs', async () => {
    const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();
    const entries = [
      { slug: 'old', last_remote_job_at: daysAgo(61), created_at: daysAgo(100) },
      { slug: 'recent', last_remote_job_at: daysAgo(59), created_at: daysAgo(100) },
      { slug: 'boundary', last_remote_job_at: daysAgo(60), created_at: daysAgo(100) },
      { slug: 'null-old', last_remote_job_at: null, created_at: daysAgo(61) },
      { slug: 'null-recent', last_remote_job_at: null, created_at: daysAgo(59) },
      { slug: 'already-inactive', active: false, last_remote_job_at: null, created_at: daysAgo(61) },
    ];
    const inserted = await db.from('companies').insert(entries.map((e) => ({ name: e.slug, ats: 'greenhouse', discovered_via: 'fixture', active: true, ...e }))).select();
    expect(inserted.error).toBeNull();
    expect((await db.from('jobs').insert({ company_id: inserted.data!.find((c) => c.slug === 'old')!.id,
      dedupe_key: 'keep-open', title: 'Existing', company: 'old', description: '', posted_at: daysAgo(90) })).error).toBeNull();
    const result = await runOnce(dependencies());
    expect(result.status).toBe('ok');
    const companies = await db.from('companies').select('slug, active');
    expect(companies.error).toBeNull();
    expect(Object.fromEntries(companies.data!.map((c) => [c.slug, c.active]))).toEqual({
      old: false, recent: true, boundary: true, 'null-old': false, 'null-recent': true, 'already-inactive': false });
    expect((await storedRun(result.runId)).stats).toMatchObject({ 'companies.deactivated': 2 });
    expect((await db.from('jobs').select('status').single()).data!.status).toBe('open');
  });

  it.each(['POST', 'PATCH'])('releases the lock when runs persistence fails on %s', async (method) => {
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method === method && new URL(request.url).pathname === '/rest/v1/runs') {
        return Promise.resolve(new Response(JSON.stringify({ message: 'private DB failure', code: 'XX000' }),
          { status: 400, headers: { 'content-type': 'application/json' } }));
      }
      return realFetch(input, init);
    });
    await expect(runOnce({ ...dependencies(), db: testDb() })).rejects.toThrow();
    vi.unstubAllGlobals();
    expect((await runOnce(dependencies())).status).toBe('ok');
  });
});

describe('main scheduler boundary', () => {
  afterEach(() => {
    vi.doUnmock('../src/pipeline/run.js'); vi.doUnmock('../src/config.js'); vi.doUnmock('../src/db.js');
    vi.doUnmock('../src/email/smtp.js'); vi.doUnmock('../src/ai/client.js'); vi.doUnmock('croner');
    vi.restoreAllMocks(); vi.resetModules(); process.exitCode = 0;
  });

  async function setup(status: 'ok' | 'partial' | 'failed' | 'skipped' = 'ok') {
    vi.resetModules();
    const run = vi.fn().mockResolvedValue({ runId: status === 'skipped' ? null : 'fixture-run', status });
    const schedules: { pattern: string; options: unknown; callback: () => Promise<unknown> }[] = [];
    vi.doMock('../src/pipeline/run.js', () => ({ runOnce: run }));
    vi.doMock('../src/config.js', () => ({ loadConfig: () => ({ runCron: '15 8 * * *', tz: 'Europe/Belgrade', smtp: {}, anthropicApiKey: 'fixture' }) }));
    vi.doMock('../src/db.js', () => ({ createDb: () => ({}) }));
    vi.doMock('../src/email/smtp.js', () => ({ createSmtpMailer: () => async () => {} }));
    vi.doMock('../src/ai/client.js', () => ({ UsageMeter, createCaller: () => async () => null }));
    vi.doMock('croner', () => ({ Cron: class {
      constructor(pattern: string, options: unknown, callback: () => Promise<unknown>) { schedules.push({ pattern, options, callback }); }
      nextRun() { return new Date('2026-11-07T07:15:00Z'); }
    } }));
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    return { main: (await import('../src/main.js')).main, run, schedules, output };
  }

  it.each(['ok', 'partial', 'failed', 'skipped'] as const)('--once runs exactly once and maps %s to the proper exit code', async (status) => {
    const { main, run, schedules } = await setup(status);
    await main(['--once']);
    expect(run).toHaveBeenCalledOnce();
    expect(schedules).toEqual([]);
    expect(process.exitCode ?? 0).toBe(status === 'failed' ? 1 : 0);
  });

  it('schedules with timezone/protection and creates a new caller and meter on each invocation', async () => {
    const { main, run, schedules, output } = await setup();
    await main([]);
    expect(run).not.toHaveBeenCalled();
    expect(schedules).toHaveLength(1);
    expect(schedules[0]).toMatchObject({ pattern: '15 8 * * *', options: { timezone: 'Europe/Belgrade', protect: true } });
    expect(JSON.stringify(output.mock.calls)).toContain('2026-11-07T07:15:00.000Z');
    await schedules[0].callback();
    run.mock.calls[0][0].meter.addFailure('refusal');
    await schedules[0].callback();
    expect(run.mock.calls[1][0].meter).not.toBe(run.mock.calls[0][0].meter);
    expect(run.mock.calls[1][0].meter.failures).toBe(0);
    expect(run.mock.calls[1][0].call).not.toBe(run.mock.calls[0][0].call);
  });

  it('handles infrastructure rejection without leaking error text and lets the next schedule run', async () => {
    const { main, run, schedules } = await setup();
    await main([]);
    run.mockRejectedValueOnce(new Error('private key sk-secret'));
    expect(schedules).toHaveLength(1);
    await expect(schedules[0].callback()).resolves.toBeUndefined();
    await schedules[0].callback();
    expect(run).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('sk-secret');
  });
});
