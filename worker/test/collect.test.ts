import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AtsName, BoardName, RawJob } from '../src/domain.js';
import type { AtsAdapter, BoardAdapter } from '../src/sources/types.js';
import { AI_CONCURRENCY } from '../src/constants.js';
import { lever } from '../src/sources/ats/lever.js';
import { HttpError } from '../src/util/http.js';
import { collect, pickLink } from '../src/pipeline/collect.js';
import { createRunLog } from '../src/pipeline/runlog.js';
import { resetDb, testDb, withTestSql } from './helpers/db.js';

const atsNames: AtsName[] = ['ashby', 'greenhouse', 'lever', 'recruitee'];
const listing = 'https://boards.greenhouse.io/acme/jobs/42';
function raw(source: RawJob['source'], externalId = '42', patch: Partial<RawJob> = {}): RawJob {
  return { source, externalId, url: `https://${source}.example.test/jobs/${externalId}`,
    title: 'Engineer', company: 'Acme Inc', locationText: 'Europe', salary: null,
    descriptionText: 'Build our remote product', postedAt: null, applyUrl: null, remoteHint: true, ...patch };
}
function board(name: BoardName, jobs: RawJob[] = []): BoardAdapter {
  return { name, fetchJobs: async () => jobs };
}
function adapters(overrides: Partial<Record<AtsName, AtsAdapter>> = {}): Record<AtsName, AtsAdapter> {
  return Object.fromEntries(atsNames.map((ats) => [ats, overrides[ats] ?? { ats, fetchCompany: async () => [] }])) as Record<AtsName, AtsAdapter>;
}
let db: ReturnType<typeof testDb>;
beforeAll(() => { db = testDb(); });
beforeEach(resetDb);
afterEach(() => vi.unstubAllGlobals());
async function run(boards: BoardAdapter[] = [], ats = adapters()) {
  const log = createRunLog();
  await collect(db, log, { boards, ats });
  return log;
}
async function company(ats: AtsName = 'greenhouse', slug = 'acme', active = true) {
  const result = await db.from('companies').insert({ ats, slug, name: 'Acme Inc', discovered_via: 'fixture', active }).select().single();
  expect(result.error).toBeNull();
  return result.data!;
}
async function rows(table: 'jobs' | 'job_sources' | 'companies' | 'matches' | 'source_poll_state') {
  const result = await db.from(table).select();
  expect(result.error).toBeNull();
  return result.data!;
}
async function snapshot() {
  return withTestSql(async (sql) => ({ jobs: await sql`select * from public.jobs order by title`,
    sources: await sql`select * from public.job_sources order by source, external_id` }));
}
async function ageSources() {
  await withTestSql(async (sql) => { await sql`update public.job_sources set last_seen_at = now() - interval '2 hours'`; });
}

describe('RunLog and links', () => {
  it('accumulates exact errors and counters independently per run', () => {
    const log = createRunLog();
    log.inc('skipped'); log.inc('skipped', 3); log.inc('zero', 0);
    log.addError({ stage: 'collect', source: 'wwr', message: 'bad record' });
    expect(log.stats).toEqual({ skipped: 4, zero: 0 });
    expect(log.errors).toEqual([{ stage: 'collect', source: 'wwr', message: 'bad record' }]);
    expect(createRunLog().errors).toEqual([]);
    expect(createRunLog().stats).toEqual({});
  });
  it('pickLink prefers the ATS url and credits both original listings', () => {
    expect(pickLink([{ source: 'jobicy', url: 'https://jobicy.com/jobs/42' }, { source: 'greenhouse', url: listing }]))
      .toEqual({ url: listing, credits: [{ name: 'Greenhouse', url: listing }, { name: 'Jobicy', url: 'https://jobicy.com/jobs/42' }] });
  });
  it('pickLink skips and does not credit a stale ATS source while a live source remains', () => {
    expect(pickLink([{ source: 'greenhouse', url: listing, stale_at: '2026-11-07T00:00:00Z' },
      { source: 'jobicy', url: 'https://jobicy.com/jobs/42', stale_at: null }]))
      .toEqual({ url: 'https://jobicy.com/jobs/42', credits: [{ name: 'Jobicy', url: 'https://jobicy.com/jobs/42' }] });
    expect(pickLink([{ source: 'greenhouse', url: listing, stale_at: '2026-11-07T00:00:00Z' }]).url).toBe(listing);
  });
  it('pickLink for a jobicy-only job returns the jobicy url', () => {
    expect(pickLink([{ source: 'jobicy', url: 'https://jobicy.com/jobs/42' }]).url).toBe('https://jobicy.com/jobs/42');
  });
  it('orders board credits, deduplicates sources, and rejects an empty link list', () => {
    const result = pickLink(['hn', 'arbeitnow', 'remoteok', 'wwr', 'jobicy', 'hn'].map((source, i) => ({ source: source as BoardName, url: `https://example.test/${i}` })));
    expect(result.credits.map((c) => c.name)).toEqual(['Jobicy', 'We Work Remotely', 'Remote OK', 'Arbeitnow', 'Hacker News']);
    expect(result.credits.at(-1)?.url).toBe('https://example.test/0');
    expect(() => pickLink([])).toThrow();
  });
});

describe('collect identity and enrichment of stored fields', () => {
  it('merges the same job from greenhouse and jobicy into one jobs row with two job_sources', async () => {
    const co = await company();
    const log = await run([board('jobicy', [raw('jobicy', 'board42', { applyUrl: listing, remoteHint: true })])], adapters({
      greenhouse: { ats: 'greenhouse', fetchCompany: async () => [raw('greenhouse', '42', { url: listing, remoteHint: false, salary: { min: 100, max: 200, currency: 'EUR', period: 'year' } })] },
    }));
    expect(log.errors).toEqual([]);
    const state = await snapshot();
    expect(state.jobs).toHaveLength(1);
    expect(state.jobs[0]).toMatchObject({ company_id: co.id, salary_min: '100', salary_max: '200' });
    expect(state.sources).toHaveLength(2);
    expect(state.sources.map((s) => [s.source, s.remote_hint, s.company_id])).toEqual([['greenhouse', false, co.id], ['jobicy', true, null]]);
    expect(new Set(state.sources.map((s) => s.last_seen_at.toISOString())).size).toBe(1);
  });
  it.each([null, '2026-01-01T00:00:00+00:00'])('leaves last_remote_job_at unchanged for remote-hinted ATS collection: %s', async (lastRemoteJobAt) => {
    const co = await company('ashby');
    expect((await db.from('companies').update({ last_remote_job_at: lastRemoteJobAt }).eq('id', co.id)).error).toBeNull();
    const ats = adapters({ ashby: { ats: 'ashby', fetchCompany: async () => [raw('ashby', 'long-lived', {
      postedAt: new Date('2026-01-01T00:00:00Z'), remoteHint: true,
    })] } });
    // Neither the initial insert nor a repeated observation owns enrichment's timestamp.
    for (let observation = 0; observation < 2; observation++) {
      const log = await run([], ats);
      expect(log.errors).toEqual([]);
      expect(await rows('job_sources')).toMatchObject([{ source: 'ashby', company_id: co.id, remote_hint: true }]);
      const saved = await db.from('companies').select('last_remote_job_at').eq('id', co.id).single();
      expect(saved.error).toBeNull();
      expect(saved.data?.last_remote_job_at).toBe(lastRemoteJobAt);
    }
  });
  it('resolves stable identity before a changed grouping key and reopens without losing emailed history', async () => {
    await run([board('wwr', [raw('wwr')])]);
    const job = (await db.from('jobs').select().single().throwOnError()).data!;
    await withTestSql(async (sql) => {
      await sql`update public.jobs set status = 'closed' where id = ${job.id}`;
      const [reader] = await sql`insert into public.subscribers (email, prompt, location) values ('fixture@example.test', 'Engineer', 'Europe') returning id`;
      await sql`insert into public.matches (subscriber_id, job_id, score, reason, is_match, emailed_at) values (${reader.id}, ${job.id}, 90, 'fits', true, '2026-01-01Z')`;
    });
    await run([board('wwr', [raw('wwr', '42', { title: 'Senior Engineer', locationText: 'US' })])]);
    expect(await rows('jobs')).toMatchObject([{ id: job.id, status: 'open' }]);
    expect(await rows('job_sources')).toHaveLength(1);
    expect(await rows('matches')).toMatchObject([{ job_id: job.id, emailed_at: '2026-01-01T00:00:00+00:00' }]);
  });
  it('keeps same-source different IDs separate even with identical content and links', async () => {
    await run([board('wwr', [raw('wwr', '1'), raw('wwr', '2')])]);
    const jobs = await rows('jobs');
    expect(jobs).toHaveLength(2);
    expect(new Set(jobs.map((j) => 'dedupe_key' in j && j.dedupe_key)).size).toBe(2);
  });
  it('keeps US and EU postings separate even when their application URL matches', async () => {
    await company();
    await run([board('wwr', [raw('wwr', 'us', { locationText: 'US', applyUrl: listing })])], adapters({
      greenhouse: { ats: 'greenhouse', fetchCompany: async () => [raw('greenhouse', 'eu', { locationText: 'EU', url: listing })] },
    }));
    expect(await rows('jobs')).toHaveLength(2);
  });
  it('keeps unknown locations and unrelated links ambiguous', async () => {
    await run([board('wwr', [raw('wwr', '1', { locationText: null })]), board('remoteok', [raw('remoteok', '2', { locationText: null })])]);
    expect(await rows('jobs')).toHaveLength(2);
  });
  it('does not treat a shared generic application page as job identity', async () => {
    const applyUrl = 'https://acme.example.test/careers';
    await run([board('wwr', [raw('wwr', '1', { locationText: null, applyUrl })]),
      board('remoteok', [raw('remoteok', '2', { locationText: null, applyUrl })])]);
    expect(await rows('jobs')).toHaveLength(2);
  });
  it('merges matching nonempty location and description but not merely company/title/location', async () => {
    await run([board('wwr', [raw('wwr')]), board('remoteok', [raw('remoteok')]),
      board('arbeitnow', [raw('arbeitnow', '3', { descriptionText: 'A different engineering role' })])]);
    expect(await rows('jobs')).toHaveLength(2);
  });
  it('does not choose arbitrarily among multiple compatible candidates', async () => {
    await run([board('wwr', [raw('wwr', '1'), raw('wwr', '2')])]);
    await run([board('remoteok', [raw('remoteok')])]);
    expect(await rows('jobs')).toHaveLength(3);
  });
  it('fills null fields but preserves an existing posting date', async () => {
    await run([board('wwr', [raw('wwr', '42', { locationText: null, postedAt: new Date('2026-01-01Z'), applyUrl: listing })])]);
    await company();
    await run([], adapters({ greenhouse: { ats: 'greenhouse', fetchCompany: async () => [raw('greenhouse', '42', { postedAt: new Date('2026-11-05Z'), url: listing })] } }));
    expect((await snapshot()).jobs).toMatchObject([{ location_text: 'Europe', posted_at: new Date('2026-01-01Z') }]);
  });
  it.each([
    ['EUR', 'year'], ['USD', 'hour'], [null, 'year'], ['USD', null],
  ] as const)('does not combine partial salary bounds with incompatible units %s/%s', async (currency, period) => {
    await run([board('wwr', [raw('wwr', '42', { salary: { min: 100, max: null, currency: 'USD', period: 'year' } })])]);
    await run([board('remoteok', [raw('remoteok', '42', { salary: { min: null, max: 200, currency, period } })])]);
    expect((await snapshot()).jobs).toMatchObject([{ salary_min: '100', salary_max: null, salary_currency: 'USD', salary_period: 'year' }]);
  });
  it('fills compatible partial salary bounds and a missing posting date', async () => {
    await run([board('wwr', [raw('wwr', '42', { salary: { min: 100, max: null, currency: 'USD', period: 'year' } })])]);
    await run([board('remoteok', [raw('remoteok', '42', { postedAt: new Date('2026-01-01Z'), salary: { min: null, max: 200, currency: 'USD', period: 'year' } })])]);
    expect((await snapshot()).jobs).toMatchObject([{ salary_min: '100', salary_max: '200', posted_at: new Date('2026-01-01Z') }]);
  });
  it('atomically resolves concurrent copies without orphan jobs', async () => {
    const logs = await Promise.all([run([board('wwr', [raw('wwr')])]), run([board('wwr', [raw('wwr')])]), run([board('remoteok', [raw('remoteok')])])]);
    expect(logs.flatMap((l) => l.errors)).toEqual([]);
    expect(await rows('jobs')).toHaveLength(1);
    expect(await rows('job_sources')).toHaveLength(2);
  });
});

describe('discovery, diagnostics and poll guards', () => {
  it('discovers a lever company from a remoteok applyUrl and fills company_id only after actual ATS collection', async () => {
    let observedUnowned = false;
    const log = await run([board('remoteok', [raw('remoteok', '42', { applyUrl: 'https://jobs.lever.co/acme/42', companyAts: { ats: 'lever', slug: 'acme' } })])], adapters({
      lever: { ats: 'lever', fetchCompany: async (slug) => {
        expect(slug).toBe('acme');
        observedUnowned = (await snapshot()).jobs[0].company_id === null;
        return [];
      } },
    }));
    expect(log.errors).toEqual([]);
    expect(observedUnowned).toBe(true);
    expect(await rows('companies')).toMatchObject([{ ats: 'lever', slug: 'acme', discovered_via: 'remoteok' }]);
    expect((await snapshot()).jobs[0].company_id).toBeNull();
  });
  it('retains valid board items and exact skipped diagnostics, including all-invalid rejection', async () => {
    const log = await run([
      { name: 'wwr', fetchJobs: async (issue) => { issue?.({ source: 'wwr', skipped: 3, message: '3 invalid records' }); return [raw('wwr')]; } },
      { name: 'remoteok', fetchJobs: async (issue) => { issue?.({ source: 'remoteok', skipped: 2, message: '2 invalid records' }); throw new Error('all invalid'); } },
    ]);
    expect(await rows('jobs')).toHaveLength(1);
    expect(log.stats.collect_skipped_records).toBe(5);
    expect(log.errors).toEqual(expect.arrayContaining([
      { stage: 'collect', source: 'wwr', message: '3 invalid records' },
      { stage: 'collect', source: 'remoteok', message: '2 invalid records' },
      { stage: 'collect', source: 'remoteok', message: 'all invalid' },
    ]));
  });
  it.each([
    new HttpError('https://example.test', 500), new SyntaxError('Unexpected token <, HTML is not JSON'),
    z.object({ jobs: z.array(z.string()) }).safeParse({ jobs: 'bad' }).error!,
  ])('logs adapter failures and still upserts other sources: %s', async (error) => {
    const log = await run([{ name: 'wwr', fetchJobs: async () => { throw error; } }, board('remoteok', [raw('remoteok')])]);
    expect(log.errors[0]).toMatchObject({ stage: 'collect', source: 'wwr',
      message: error.message.replace(/\s+/g, ' ').trim().slice(0, 200) });
    expect(log.errors[0].message).not.toMatch(/\n/);
    expect(await rows('jobs')).toHaveLength(1);
  });
  it.each([false, true])('persists empty/failed Jobicy attempts and counts skipped polls (fails=%s)', async (fails) => {
    let polls = 0;
    const adapter: BoardAdapter = { name: 'jobicy', fetchJobs: async () => { polls++; if (fails) throw new Error('unavailable'); return []; } };
    await run([adapter]);
    const log = await run([adapter]);
    expect(polls).toBe(1);
    expect(log.stats.collect_skipped_polls).toBe(1);
    expect(await rows('source_poll_state')).toHaveLength(1);
    expect(await rows('job_sources')).toHaveLength(0);
    await withTestSql(async (sql) => { await sql`update public.source_poll_state set last_attempt_at = now() - interval '61 minutes'`; });
    await run([adapter]);
    expect(polls).toBe(2);
  });
  it('allows only one concurrent Jobicy attempt', async () => {
    let polls = 0;
    const adapter: BoardAdapter = { name: 'jobicy', fetchJobs: async () => { polls++; return []; } };
    const logs = await Promise.all([run([adapter]), run([adapter])]);
    expect(polls).toBe(1);
    expect(logs.reduce((sum, l) => sum + (l.stats.collect_skipped_polls ?? 0), 0)).toBe(1);
  });
  it('rejects out-of-scope sources without discovering companies', async () => {
    const invalid = { name: 'remotive', fetchJobs: async () => [raw('wwr', 'bad', { companyAts: { ats: 'lever', slug: 'bad' } })] } as unknown as BoardAdapter;
    const log = await run([invalid]);
    expect(log.errors).toHaveLength(1);
    expect(await rows('companies')).toHaveLength(0);
    expect(await rows('jobs')).toHaveLength(0);
  });
  it('rolls back a failed source batch including discovery and keeps other sources', async () => {
    const log = await run([board('wwr', [raw('wwr', '1', { companyAts: { ats: 'lever', slug: 'rollback' } }), raw('wwr', '2', { descriptionText: null as unknown as string })]),
      board('remoteok', [raw('remoteok', 'good')])]);
    expect(log.errors).toEqual([{ stage: 'collect', source: 'wwr', message: 'Invalid collect item' }]);
    expect(await rows('companies')).toHaveLength(0);
    expect((await snapshot()).sources).toMatchObject([{ source: 'remoteok', external_id: 'good' }]);
  });
});

describe('successful ATS absence and scheduling', () => {
  it.each(atsNames)('closes a %s 404 board\'s jobs at once and deactivates it only on the third consecutive 404', async (ats) => {
    const co = await company(ats, 'dead-slug');
    await run([], adapters({ [ats]: { ats, fetchCompany: async () => [raw(ats)] } }));
    let polls = 0;
    const failed = adapters({ [ats]: { ats, fetchCompany: async () => {
      polls++; throw new HttpError('https://example.test/dead', 404);
    } } });
    const companyRow = async () => (await db.from('companies').select('active, not_found_runs').eq('id', co.id).single()).data;
    const first = await run([], failed);
    expect((await snapshot()).jobs.map((job) => job.status)).toEqual(['closed']);
    expect(first.stats.collect_closed).toBe(1);
    expect(first.errors).toEqual([{ stage: 'collect', source: ats, message: 'dead-slug: HTTP request failed (404)' }]);
    expect(await companyRow()).toEqual({ active: true, not_found_runs: 1 });
    expect(first.stats.collect_dead_boards).toBe(0);
    await run([], failed);
    expect(await companyRow()).toEqual({ active: true, not_found_runs: 2 });
    const third = await run([], failed);
    expect(await companyRow()).toEqual({ active: false, not_found_runs: 3 });
    expect(third.stats.collect_dead_boards).toBe(1);
    expect((await run([], failed)).errors).toEqual([]);
    expect(polls).toBe(3);
  });

  it('resets the 404 streak and reopens the jobs when the board comes back', async () => {
    const co = await company('greenhouse', 'flaky-slug');
    const ok = adapters({ greenhouse: { ats: 'greenhouse', fetchCompany: async () => [raw('greenhouse')] } });
    const missing = adapters({ greenhouse: { ats: 'greenhouse', fetchCompany: async () => {
      throw new HttpError('https://example.test/flaky', 404);
    } } });
    await run([], ok);
    await run([], missing);
    await run([], missing);
    expect((await snapshot()).jobs.map((job) => job.status)).toEqual(['closed']);
    const back = await run([], ok);
    expect(back.errors).toEqual([]);
    expect((await snapshot()).jobs.map((job) => job.status)).toEqual(['open']);
    expect((await db.from('companies').select('active, not_found_runs').eq('id', co.id).single()).data)
      .toEqual({ active: true, not_found_runs: 0 });
    await run([], missing);
    await run([], missing);
    expect((await db.from('companies').select('active').eq('id', co.id).single()).data?.active).toBe(true);
  });

  it('keeps the rest of an ATS company when its adapter skips invalid jobs, naming the slug', async () => {
    await company('lever', 'partial-slug');
    const log = await run([], adapters({ lever: { ats: 'lever', fetchCompany: async (_slug, _name, onIssue) => {
      onIssue?.({ source: 'lever', skipped: 1, message: 'Skipped 1 invalid items: text: invalid_type' });
      return [raw('lever')];
    } } }));
    expect(await rows('jobs')).toHaveLength(1);
    expect(log.stats.collect_skipped_records).toBe(1);
    expect(log.errors).toEqual([{ stage: 'collect', source: 'lever',
      message: 'partial-slug: Skipped 1 invalid items: text: invalid_type' }]);
  });

  it.each([new HttpError('https://example.test', 500), new HttpError('https://example.test', 401),
    new Error('invalid response')])('keeps retryable ATS failures active with a slug: %s', async (error) => {
    const co = await company('ashby', 'retry-slug');
    const log = await run([], adapters({ ashby: { ats: 'ashby', fetchCompany: async () => { throw error; } } }));
    expect((await db.from('companies').select('active').eq('id', co.id).single()).data?.active).toBe(true);
    expect(log.stats.collect_dead_boards ?? 0).toBe(0);
    expect(log.errors).toEqual([{ stage: 'collect', source: 'ashby', message: `retry-slug: ${error.message}` }]);
  });

  it.each([200, 404, 401])('decides Lever deactivation only after its EU fallback returns %s', async (status) => {
    const co = await company('lever', 'eu-slug');
    const urls: string[] = [];
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).hostname === '127.0.0.1') return realFetch(input, init);
      urls.push(request.url);
      return urls.length === 1 ? new Response('', { status: 404 })
        : status === 200 ? Response.json([]) : new Response('', { status });
    });
    const log = await run([], adapters({ lever }));
    expect(urls).toEqual(['https://api.lever.co/v0/postings/eu-slug?mode=json',
      'https://api.eu.lever.co/v0/postings/eu-slug?mode=json']);
    expect((await db.from('companies').select('not_found_runs').eq('id', co.id).single()).data?.not_found_runs)
      .toBe(status === 404 ? 1 : 0);
    expect(log.errors).toEqual(status === 200 ? [] : [{ stage: 'collect', source: 'lever',
      message: `eu-slug: HTTP request failed (${status})` }]);
  });

  it('closes an ATS job missing from a successful fetch, not when the fetch failed', async () => {
    await company();
    await run([], adapters({ greenhouse: { ats: 'greenhouse', fetchCompany: async () => [raw('greenhouse')] } }));
    await ageSources();
    const log = await run([], adapters({ greenhouse: { ats: 'greenhouse', fetchCompany: async () => { throw new Error('500'); } } }));
    expect(log.errors).toHaveLength(1);
    expect((await snapshot()).jobs[0].status).toBe('open');
    await run();
    expect((await snapshot()).jobs[0].status).toBe('closed');
    await run([], adapters({ greenhouse: { ats: 'greenhouse', fetchCompany: async () => [raw('greenhouse')] } }));
    expect((await snapshot()).jobs[0].status).toBe('open');
  });
  it('does not close a board-only job that disappeared or a mixed board/ATS job', async () => {
    await company();
    await run([board('wwr', [raw('wwr'), raw('wwr', 'other', { title: 'Designer' })])], adapters({ greenhouse: { ats: 'greenhouse', fetchCompany: async () => [raw('greenhouse')] } }));
    await ageSources();
    await run();
    expect((await snapshot()).jobs.map((j) => j.status)).toEqual(['open', 'open']);
  });
  it('scopes absence to the successful company and leaves failed/inactive companies open', async () => {
    await company('greenhouse', 'a'); await company('greenhouse', 'b'); const inactive = await company('greenhouse', 'c');
    await run([], adapters({ greenhouse: { ats: 'greenhouse', fetchCompany: async (slug) => [raw('greenhouse', slug, { title: slug })] } }));
    await ageSources();
    expect((await db.from('companies').update({ active: false }).eq('id', inactive.id)).error).toBeNull();
    await run([], adapters({ greenhouse: { ats: 'greenhouse', fetchCompany: async (slug) => { if (slug === 'b') throw new Error('failed'); return []; } } }));
    expect((await snapshot()).jobs.map((j) => [j.title, j.status])).toEqual([['a', 'closed'], ['b', 'open'], ['c', 'open']]);
  });
  it('requires successful absence of every ATS provenance before closing a shared job', async () => {
    await company('greenhouse'); await company('lever');
    await run([], adapters({ greenhouse: { ats: 'greenhouse', fetchCompany: async () => [raw('greenhouse')] }, lever: { ats: 'lever', fetchCompany: async () => [raw('lever')] } }));
    expect(await rows('jobs')).toHaveLength(1);
    await ageSources();
    await run([], adapters({ lever: { ats: 'lever', fetchCompany: async () => { throw new Error('failed'); } } }));
    expect((await snapshot()).jobs[0].status).toBe('open');
    await run();
    expect((await snapshot()).jobs[0].status).toBe('closed');
  });
  it('keeps refreshed and missing sources on opposite sides of the same collect timestamp', async () => {
    await company();
    await run([], adapters({ greenhouse: { ats: 'greenhouse', fetchCompany: async () => [raw('greenhouse', 'keep'), raw('greenhouse', 'gone')] } }));
    await ageSources();
    await run([], adapters({ greenhouse: { ats: 'greenhouse', fetchCompany: async () => [raw('greenhouse', 'keep')] } }));
    const state = await snapshot();
    expect(state.jobs.filter((j) => j.status === 'closed')).toHaveLength(1);
    expect(state.sources.find((s) => s.external_id === 'keep')?.stale_at).toBeNull();
    expect(state.sources.find((s) => s.external_id === 'gone')?.stale_at).toBeInstanceOf(Date);
  });
  it('does not close or partially store an ATS batch that cannot persist', async () => {
    await company();
    await run([], adapters({ greenhouse: { ats: 'greenhouse', fetchCompany: async () => [raw('greenhouse', 'old')] } }));
    await ageSources();
    const log = await run([], adapters({ greenhouse: { ats: 'greenhouse', fetchCompany: async () => [raw('greenhouse', 'new'), raw('greenhouse', 'bad', { descriptionText: null as unknown as string })] } }));
    expect(log.errors).toEqual([{ stage: 'collect', source: 'greenhouse', message: 'acme: Invalid collect item' }]);
    expect((await snapshot()).sources.map((s) => s.external_id)).toEqual(['old']);
    expect((await snapshot()).jobs[0].status).toBe('open');
  });
  it('runs boards before active ATS companies and bounds adapter concurrency', async () => {
    for (let n = 0; n < AI_CONCURRENCY + 2; n++) await company('greenhouse', `company-${n}`);
    let boardsDone = false; let active = 0; let peak = 0; let total = 0;
    await run([{ name: 'wwr', fetchJobs: async () => { boardsDone = true; return []; } }], adapters({
      greenhouse: { ats: 'greenhouse', fetchCompany: async () => {
        expect(boardsDone).toBe(true); active++; total++; peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 20)); active--; return [];
      } },
    }));
    expect(total).toBe(AI_CONCURRENCY + 2);
    expect(peak).toBe(AI_CONCURRENCY);
  });
  it('collects active companies beyond the API page limit', async () => {
    await withTestSql(async (sql) => {
      await sql`insert into public.companies (id, name, ats, slug, discovered_via)
        select ('00000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
          'Acme', 'greenhouse', n::text, 'fixture' from generate_series(1, 1001) as n`;
    });
    const log = await run([], adapters({ greenhouse: { ats: 'greenhouse', fetchCompany: async (slug) =>
      slug === '1001' ? [raw('greenhouse', slug)] : [] } }));
    expect(log.errors).toEqual([]);
    expect((await snapshot()).sources).toMatchObject([{ external_id: '1001', company_id: '00000000-0000-0000-0000-000000001001' }]);
  }, 30_000);
  it('restricts collect RPC execution to service_role and uses invoker privileges', async () => {
    await withTestSql(async (sql) => {
      const functions = await sql`select p.oid, p.proname, p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('collect_source_batch', 'claim_jobicy_poll')`;
      expect(functions).toHaveLength(2);
      for (const fn of functions) {
        expect(fn.prosecdef).toBe(false);
        for (const role of ['anon', 'authenticated', 'service_role']) {
          const [permission] = await sql`select has_function_privilege(${role}, ${fn.oid}::oid, 'EXECUTE') as allowed`;
          expect(permission.allowed).toBe(role === 'service_role');
        }
      }
    });
  });
});
