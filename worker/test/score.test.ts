import Anthropic from '@anthropic-ai/sdk';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StructuredCaller } from '../src/ai/client.js';
import * as schemas from '../src/ai/schemas.js';
import type { Constraints, Enrichment } from '../src/ai/schemas.js';
import type { Database } from '../src/db.types.js';
import { score } from '../src/pipeline/score.js';
import { createRunLog } from '../src/pipeline/runlog.js';
import { resetDb, testDb, withTestSql } from './helpers/db.js';

const now = new Date('2026-11-06T12:00:00Z');
const boundary = '2026-10-23T12:00:00Z';
const old = '2026-10-17T12:00:00Z';
const constraints: Constraints = {
  salary_floor_usd_year: 80_000, seniority_allowed: ['senior'], role_families: ['backend'],
  country: 'RS', regions: ['europe', 'emea'],
};
const enrichment: Enrichment = {
  is_remote: true, regions: ['europe'], countries: [], seniority: 'senior', role_family: 'backend',
  technologies: ['TypeScript'], salary_usd_year_min: 90_000, salary_usd_year_max: 110_000,
  company_size: 40, summary: 'Build remote APIs.',
};
type Subscriber = Database['public']['Tables']['subscribers']['Row'];
type JobInsert = Database['public']['Tables']['jobs']['Insert'];
type Result = { job_id: string; score: number; reason: string };
type Payload = { prompt: string; constraints: Constraints; jobs: { id: string; title: string }[] };
let db: ReturnType<typeof testDb>;
const hash = (prompt: string, location: string) => createHash('sha256').update(`${prompt}\n${location}`).digest('hex');

async function subscriber(patch: Partial<Subscriber> = {}) {
  const input = { email: `${randomUUID()}@example.test`, prompt: 'Senior backend, above USD 80000/year',
    location: 'Serbia', constraints, ...patch };
  const result = await db.from('subscribers').insert({ ...input,
    prompt_hash: hash(input.prompt, input.location), ...patch }).select().single();
  expect(result.error).toBeNull();
  return result.data!;
}
async function jobs(count = 1, patch: Partial<JobInsert> = {}, enriched: Partial<Enrichment> | null = {}) {
  const result = await db.from('jobs').insert(Array.from({ length: count }, () => ({
    dedupe_key: randomUUID(), title: 'Engineer', company: 'Acme', description: 'Remote APIs',
    first_seen_at: now.toISOString(), ...patch,
  }))).select();
  expect(result.error).toBeNull();
  if (enriched !== null) expect((await db.from('job_enrichment').insert(
    result.data!.map((j) => ({ job_id: j.id, ...enrichment, ...enriched })),
  )).error).toBeNull();
  return result.data!;
}
async function cycle(s: Subscriber, ids: string[], closed = false, patch = {}) {
  const result = await db.from('catchup_cycles').insert({ subscriber_id: s.id, prompt_hash: s.prompt_hash!,
    closed_at: closed ? now.toISOString() : null, ...patch }).select().single();
  expect(result.error).toBeNull();
  if (ids.length) expect((await db.from('catchup_members').insert(
    ids.map((job_id) => ({ cycle_id: result.data!.id, job_id })),
  )).error).toBeNull();
  return result.data!;
}
async function stored() {
  const result = await db.from('matches').select().order('job_id');
  expect(result.error).toBeNull();
  return result.data!;
}
function results(user: string, value = 80): Result[] {
  return (JSON.parse(user) as Payload).jobs.map((j) => ({ job_id: j.id, score: value,
    reason: 'The listed salary is above your floor.' }));
}
function caller(value = 80): StructuredCaller {
  return async ({ schema, user }) => schema.parse({ results: results(user, value) });
}

describe('score', () => {
  beforeAll(() => { db = testDb(); });
  beforeEach(async () => { await resetDb(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('validates integer scores from 0 through 100 and requires job ids and reasons', () => {
    expect(schemas.ScoreBatchSchema).toBeDefined();
    for (const value of [0, 69, 70, 100]) {
      expect(schemas.ScoreBatchSchema.safeParse({ results: [{ job_id: 'planned-id', score: value, reason: 'Fit.' }] }).success).toBe(true);
    }
    for (const result of [{ job_id: 'id', score: -1, reason: 'No.' }, { job_id: 'id', score: 101, reason: 'No.' },
      { job_id: 'id', score: 70.5, reason: 'No.' }, { job_id: 'id', score: '70', reason: 'No.' },
      { score: 70, reason: 'No.' }, { job_id: 'id', score: 70 }]) {
      expect(schemas.ScoreBatchSchema.safeParse({ results: [result] }).success).toBe(false);
    }
  });

  it('reports every prefilter reason as 0 when nothing is rejected', async () => {
    await subscriber();
    await jobs();
    const log = createRunLog();
    await score(db, log, async ({ schema, user }) => schema.parse({ results: results(user) }), now);
    expect(log.stats).toMatchObject({ 'score.prefiltered.not_remote': 0, 'score.prefiltered.region': 0,
      'score.prefiltered.salary': 0, 'score.prefiltered.seniority': 0, 'score.prefiltered.role': 0, 'score.candidates': 1 });
  });

  it('sends only pre-filter survivors with planned UUIDs and factual enrichment fields', async () => {
    const s = await subscriber();
    const [yes] = await jobs();
    await jobs(1, {}, { regions: [], countries: ['US'] });
    await jobs(1, {}, { is_remote: false });
    await jobs(1, {}, { salary_usd_year_max: 79_999 });
    await jobs(1, {}, { seniority: 'junior' });
    await jobs(1, {}, { role_family: 'design' });
    const payloads: unknown[] = [];
    const log = createRunLog();
    await score(db, log, async ({ schema, user }) => {
      expect(schema).toBe(schemas.ScoreBatchSchema);
      payloads.push(JSON.parse(user));
      return schema.parse({ results: results(user) });
    }, now);
    expect(log.stats).toMatchObject({ 'score.prefiltered.not_remote': 1, 'score.prefiltered.region': 1,
      'score.prefiltered.salary': 1, 'score.prefiltered.seniority': 1, 'score.prefiltered.role': 1, 'score.candidates': 1 });
    expect(log.errors).toEqual([]);
    expect(payloads).toEqual([{ prompt: s.prompt, constraints, jobs: [{ id: yes.id, title: 'Engineer', company: 'Acme',
      summary: 'Build remote APIs.', technologies: ['TypeScript'], seniority: 'senior',
      salary_usd_year_min: 90_000, salary_usd_year_max: 110_000,
      posted_salary: { min: null, max: null, currency: null, period: null }, regions: ['europe'], countries: [] }] }]);
    expect(await stored()).toMatchObject([{ subscriber_id: s.id, job_id: yes.id, catchup: false, suppressed: false }]);
  });

  it('passes a RemoteOK-style posted salary with unknown currency/period to the scorer', async () => {
    await subscriber();
    const [j] = await jobs(1, { salary_min: 50_000, salary_max: 60_000,
      salary_currency: null, salary_period: null }, { salary_usd_year_min: null, salary_usd_year_max: null });
    let evidence: unknown;
    let instructions = '';
    const log = createRunLog();
    await score(db, log, async ({ schema, system, user }) => {
      evidence = JSON.parse(user).jobs[0];
      instructions = system;
      return schema.parse({ results: results(user, 20) });
    }, now);
    expect(evidence).toMatchObject({ id: j.id, salary_usd_year_min: null, salary_usd_year_max: null,
      posted_salary: { min: 50_000, max: 60_000, currency: null, period: null } });
    expect(instructions).toContain('salary_floor_usd_year');
    expect(instructions).toContain('posted_salary');
    expect(await stored()).toMatchObject([{ job_id: j.id, is_match: false }]);
    expect(log.stats['score.matched']).toBe(0);
  });

  it('uses the inclusive shared cutoff with posted_at taking precedence over first_seen_at', async () => {
    await subscriber();
    const [posted] = await jobs(1, { posted_at: boundary, first_seen_at: old });
    const [fallback] = await jobs(1, { first_seen_at: boundary });
    await jobs(1, { posted_at: old });
    await jobs(1, { first_seen_at: old });
    await jobs(1, { posted_at: '2026-10-23T11:59:59.999Z' });
    await jobs(1, { first_seen_at: '2026-10-23T11:59:59.999Z' });
    await jobs(1, { status: 'closed' });
    await jobs(1, {}, null);
    // Explicit now, rather than the current clock, determines the window.
    vi.setSystemTime(new Date('2026-12-01T00:00:00Z'));
    await score(db, createRunLog(), caller(), now);
    expect((await stored()).map((m) => m.job_id).sort()).toEqual([posted.id, fallback.id].sort());
  });

  it('writes matches at 70 and non-matches at 69, counts inserted rows, and never re-scores either', async () => {
    await subscriber();
    const [yes] = await jobs(1, { title: 'Yes' });
    const [no] = await jobs(1, { title: 'No' });
    const log = createRunLog();
    await score(db, log, async ({ schema }) => schema.parse({ results: [
      { job_id: yes.id, score: 70, reason: 'Fits your needs.' }, { job_id: no.id, score: 69, reason: 'A weaker fit for you.' },
    ] }));
    expect(await stored()).toEqual(expect.arrayContaining([
      expect.objectContaining({ job_id: yes.id, score: 70, is_match: true, reason: 'Fits your needs.' }),
      expect.objectContaining({ job_id: no.id, score: 69, is_match: false }),
    ]));
    expect(log.stats).toMatchObject({ 'score.subscribers': 1, 'score.candidates': 2, 'score.batches': 1,
      'score.scored': 2, 'score.matched': 1, 'score.failed': 0 });
    let calls = 0;
    const again = createRunLog();
    await score(db, again, async () => { calls++; return null; });
    expect(calls).toBe(0);
    expect(again.stats).toMatchObject({ 'score.candidates': 0, 'score.batches': 0, 'score.scored': 0 });
    expect(await stored()).toHaveLength(2);
  });

  it('excludes existing pairs only for their subscriber, including suppressed and emailed matches', async () => {
    const a = await subscriber();
    const b = await subscriber({ prompt: 'Other backend preference' });
    const rows = await jobs(2);
    expect((await db.from('matches').insert(rows.map((j, i) => ({ subscriber_id: a.id, job_id: j.id,
      score: 69, reason: 'Preserve.', is_match: false, suppressed: i === 0,
      emailed_at: i === 1 ? now.toISOString() : null })))).error).toBeNull();
    const before = await stored();
    const log = createRunLog();
    await score(db, log, caller());
    expect((await stored()).filter((m) => m.subscriber_id === a.id)).toEqual(before);
    expect((await stored()).filter((m) => m.subscriber_id === b.id)).toHaveLength(2);
    expect(log.stats['score.candidates']).toBe(2);
  });

  it('ignores unknown and out-of-batch ids and retries omitted jobs on the next run', async () => {
    await subscriber();
    const rows = await jobs(11);
    const unknown = randomUUID();
    const sent: string[] = [];
    await score(db, createRunLog(), async ({ schema, user }) => {
      const batch = results(user);
      sent.push(...batch.map((r) => r.job_id));
      const outside = rows.find((j) => !batch.some((r) => r.job_id === j.id))!;
      return schema.parse({ results: [batch[0], { job_id: unknown, score: 99, reason: 'Invented.' },
        { job_id: outside.id, score: 99, reason: 'Outside this batch.' }] });
    });
    expect(sent).toHaveLength(11);
    expect(await stored()).toHaveLength(2);
    expect((await stored()).every((m) => m.score === 80)).toBe(true);
    const retry = createRunLog();
    await score(db, retry, caller());
    expect(retry.stats['score.candidates']).toBe(9);
    expect(await stored()).toHaveLength(11);
  });

  it('batches 23 candidates into 10, 10 and 3 and keeps a fixed system prompt across subscribers', async () => {
    await subscriber({ prompt: 'private-backend-a' });
    await subscriber({ prompt: 'private-backend-b' });
    await jobs(23);
    const sizes: number[] = [];
    const systems: string[] = [];
    await score(db, createRunLog(), async ({ schema, system, user }) => {
      systems.push(system);
      sizes.push(results(user).length);
      return schema.parse({ results: results(user) });
    });
    expect(sizes.sort((a, b) => a - b)).toEqual([3, 3, 10, 10, 10, 10]);
    expect(new Set(systems).size).toBe(1);
    expect(systems[0]).not.toContain('private-backend-');
    expect(await stored()).toHaveLength(46);
  });

  it.each([false, true])('uses only membership of the highest-ordinal cycle (closed=%s)', async (closed) => {
    const s = await subscriber();
    const [older, latest, normal] = await jobs(3);
    const previous = await cycle(s, [older.id], !closed, { created_at: '2026-11-06T13:00:00Z' });
    const current = await cycle(s, [latest.id], closed, { created_at: old });
    const log = createRunLog();
    await score(db, log, caller());
    expect(await stored()).toEqual(expect.arrayContaining([
      expect.objectContaining({ job_id: older.id, catchup: false, suppressed: false }),
      expect.objectContaining({ job_id: latest.id, catchup: true, suppressed: closed }),
      expect.objectContaining({ job_id: normal.id, catchup: false, suppressed: false }),
    ]));
    expect(log.stats).toMatchObject({ 'score.scored': 3, 'score.matched': closed ? 2 : 3,
      'score.suppressed': closed ? 1 : 0 });
    const after = await db.from('catchup_cycles').select().eq('subscriber_id', s.id).order('ordinal');
    expect(after.error).toBeNull();
    expect(after.data).toEqual([previous, current]);
  });

  it('returns suppressed status from the RPC for each inserted row and counts suppressed rows separately', async () => {
    const s = await subscriber();
    const [late, daily, nonmatch] = await jobs(3);
    await cycle(s, [late.id, nonmatch.id], true);
    const inserted = await db.rpc('insert_scored_matches', { p_subscriber_id: s.id,
      p_prompt: s.prompt, p_location: s.location, p_prompt_hash: s.prompt_hash!,
      p_results: [{ job_id: late.id, score: 80, reason: 'Late', is_match: true },
        { job_id: daily.id, score: 80, reason: 'Daily', is_match: true },
        { job_id: nonmatch.id, score: 20, reason: 'No', is_match: false }] });
    expect(inserted.error).toBeNull();
    expect(inserted.data).toEqual(expect.arrayContaining([
      { job_id: late.id, is_match: true, suppressed: true },
      { job_id: daily.id, is_match: true, suppressed: false },
      { job_id: nonmatch.id, is_match: false, suppressed: true },
    ]));
    expect((await db.from('matches').delete().eq('subscriber_id', s.id)).error).toBeNull();
    const log = createRunLog();
    await score(db, log, async ({ schema, user }) => schema.parse({ results: results(user).map((r) =>
      ({ ...r, score: r.job_id === nonmatch.id ? 20 : 80 })) }), now);
    expect(log.stats).toMatchObject({ 'score.scored': 3, 'score.matched': 1, 'score.suppressed': 2 });
  });

  it('retries null batches with durable membership and permanently suppresses a late closed-cohort member', async () => {
    const s = await subscriber();
    const [late] = await jobs();
    const c = await cycle(s, [late.id]);
    const log = createRunLog();
    await score(db, log, async () => null);
    expect(await stored()).toEqual([]);
    expect(log.errors).toEqual([{ stage: 'score', message: s.id }]);
    expect(log.stats['score.failed']).toBe(1);
    expect((await db.from('catchup_cycles').update({ closed_at: now.toISOString() }).eq('id', c.id)).error).toBeNull();
    const [daily] = await jobs();
    await score(db, createRunLog(), caller());
    expect(await stored()).toEqual(expect.arrayContaining([
      expect.objectContaining({ job_id: late.id, catchup: true, suppressed: true }),
      expect.objectContaining({ job_id: daily.id, catchup: false, suppressed: false }),
    ]));
    const before = await stored();
    await cycle(s, [], false);
    await score(db, createRunLog(), caller());
    expect(await stored()).toEqual(before);
  });

  it('reads cohort closure after the AI call and leaves closed_at untouched', async () => {
    const s = await subscriber();
    const [j] = await jobs();
    const c = await cycle(s, [j.id]);
    await score(db, createRunLog(), async ({ schema, user }) => {
      expect((await db.from('catchup_cycles').update({ closed_at: now.toISOString() }).eq('id', c.id)).error).toBeNull();
      return schema.parse({ results: results(user) });
    });
    expect(await stored()).toMatchObject([{ job_id: j.id, catchup: true, suppressed: true }]);
  });

  it('skips inactive, missing, stale and malformed stored constraints without leaking private input', async () => {
    await jobs();
    await subscriber({ active: false });
    await subscriber({ constraints: null });
    await subscriber({ prompt_hash: null });
    await subscriber({ prompt_hash: hash('Old prompt', 'Serbia') });
    await subscriber({ prompt_hash: hash('Senior backend, above USD 80000/year', 'Old location') });
    const invalid = await subscriber({ prompt: 'private invalid prompt', constraints: { country: 'secret@example.test' } });
    const valid = await subscriber();
    const log = createRunLog();
    await score(db, log, caller());
    expect(await stored()).toMatchObject([{ subscriber_id: valid.id }]);
    expect(log.errors).toEqual([{ stage: 'score', message: `${invalid.id}: invalid constraints` }]);
  });

  it.each([{ prompt: 'Edited' }, { location: 'Germany' }, { active: false }])(
    'drops stale in-flight results after subscriber changes: %j', async (patch) => {
      const s = await subscriber();
      await jobs();
      let calls = 0;
      const log = createRunLog();
      await score(db, log, async ({ schema, user }) => {
        calls++;
        expect((await db.from('subscribers').update(patch).eq('id', s.id)).error).toBeNull();
        return schema.parse({ results: results(user) });
      });
      expect(calls).toBe(1);
      expect(log.errors).toEqual([]);
      expect(await stored()).toEqual([]);
    },
  );

  it('does not overwrite a match inserted while the AI batch was in flight', async () => {
    const s = await subscriber();
    const [j] = await jobs();
    const log = createRunLog();
    await score(db, log, async ({ schema, user }) => {
      expect((await db.from('matches').insert({ subscriber_id: s.id, job_id: j.id, score: 42,
        reason: 'Keep me.', is_match: false, catchup: true, suppressed: true })).error).toBeNull();
      return schema.parse({ results: results(user) });
    });
    expect(await stored()).toMatchObject([{ score: 42, reason: 'Keep me.', is_match: false, catchup: true, suppressed: true }]);
    expect(log.stats['score.scored']).toBe(0);
  });

  it('bounds AI calls at five, counts null failures per batch and continues successful batches', async () => {
    const s = await subscriber();
    await jobs(61);
    let active = 0;
    let peak = 0;
    let calls = 0;
    const log = createRunLog();
    await score(db, log, async ({ schema, user }) => {
      const index = calls++;
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active--;
      return index < 2 ? null : schema.parse({ results: results(user) });
    });
    expect(peak).toBe(5);
    expect(calls).toBe(7);
    expect(log.errors).toEqual([{ stage: 'score', message: s.id }, { stage: 'score', message: s.id }]);
    expect(log.stats).toMatchObject({ 'score.candidates': 61, 'score.batches': 7, 'score.scored': 41, 'score.failed': 2 });
    expect(await stored()).toHaveLength(41);
  });

  it.each([
    new Anthropic.AuthenticationError(401, {}, 'private bad key', new Headers()),
    new Anthropic.NotFoundError(404, {}, 'private bad model', new Headers()),
  ])('stops queued calls and drains in-flight writes before propagating a config fault: %s', async (error) => {
    await subscriber();
    await jobs(61);
    let calls = 0;
    let settled = 0;
    const log = createRunLog();
    await expect(score(db, log, async ({ schema, user }) => {
      const index = calls++;
      if (index === 0) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
      settled++;
      return schema.parse({ results: results(user) });
    })).rejects.toBe(error);
    expect(calls).toBeGreaterThan(1);
    expect(calls).toBeLessThanOrEqual(5);
    expect(settled).toBe(calls - 1);
    expect(await stored()).toHaveLength(settled * 10);
    expect(log.errors).toEqual([]);
  });

  it('logs only subscriber ids for unexpected batch exceptions and keeps rows retryable', async () => {
    const s = await subscriber();
    await jobs();
    const log = createRunLog();
    await score(db, log, async () => { throw new Error(`${s.prompt} ${s.email}`); });
    expect(log.errors).toEqual([{ stage: 'score', message: s.id }]);
    expect(await stored()).toEqual([]);
    await score(db, createRunLog(), caller());
    expect(await stored()).toHaveLength(1);
  });

  it('does not drop candidates or cohort members beyond the API row cap', async () => {
    const s = await subscriber();
    const c = await cycle(s, [], true);
    for (let offset = 0; offset < 1_001; offset += 200) {
      const batch = await jobs(Math.min(200, 1_001 - offset));
      expect((await db.from('catchup_members').insert(batch.map((j) => ({ cycle_id: c.id, job_id: j.id })))).error).toBeNull();
    }
    const log = createRunLog();
    await score(db, log, caller());
    const result = await db.from('matches').select('id', { count: 'exact', head: true }).eq('catchup', true).eq('suppressed', true);
    expect(result.error).toBeNull();
    expect(result.count).toBe(1_001);
    expect(log.stats).toMatchObject({ 'score.candidates': 1_001, 'score.batches': 101, 'score.scored': 1_001 });
    expect(log.errors).toEqual([]);
  }, 30_000);

  it('keeps the atomic scoring RPC service-role-only with invoker privileges and an empty search path', async () => {
    await withTestSql(async (sql) => {
      const rows = await sql`select p.prosecdef, p.proconfig,
        has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
        has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'insert_scored_matches'`;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ prosecdef: false, proconfig: ['search_path=""'], anon: false, authenticated: false, service_role: true });
    });
  });

  it('re-reads a subscriber changed after stage enumeration before sending its prompt', async () => {
    await subscriber({ id: '00000000-0000-4000-8000-000000000001' });
    const later = await subscriber({ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' });
    await jobs();
    let calls = 0;
    await score(db, createRunLog(), async ({ schema, user }) => {
      calls++;
      expect((await db.from('subscribers').update({ prompt: 'Unparsed edit' }).eq('id', later.id)).error).toBeNull();
      return schema.parse({ results: results(user) });
    });
    expect(calls).toBe(1);
    expect(await stored()).toHaveLength(1);
  });

  it('keeps database write failures retryable and never logs error payloads', async () => {
    const s = await subscriber();
    await jobs();
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === '/rest/v1/rpc/insert_scored_matches') {
        return Promise.resolve(new Response(JSON.stringify({ code: 'XX000', message: `${s.prompt} ${s.email}`,
          details: null, hint: null }), { status: 500, headers: { 'content-type': 'application/json' } }));
      }
      return realFetch(input, init);
    });
    const log = createRunLog();
    await score(testDb(), log, caller());
    expect(log.errors).toEqual([{ stage: 'score', message: s.id }]);
    expect(log.stats).toMatchObject({ 'score.scored': 0, 'score.failed': 1 });
    expect(await stored()).toEqual([]);
    vi.unstubAllGlobals();
    await score(db, createRunLog(), caller());
    expect(await stored()).toHaveLength(1);
  });

  it('handles duplicate returned ids without losing other results', async () => {
    await subscriber();
    await jobs(2);
    await score(db, createRunLog(), async ({ schema, user }) => {
      const batch = results(user);
      return schema.parse({ results: [batch[0], { ...batch[0], score: 0 }, batch[1]] });
    });
    expect(await stored()).toHaveLength(2);
    expect((await stored()).every((m) => m.score === 80)).toBe(true);
  });

  it('pages subscribers beyond the API cap and scores the last subscriber', async () => {
    for (let offset = 0; offset < 1_000; offset += 200) {
      expect((await db.from('subscribers').insert(Array.from({ length: 200 }, (_, i) => ({
        id: `00000000-0000-4000-8000-${String(offset + i).padStart(12, '0')}`,
        email: `page-${offset + i}@example.test`, prompt: 'Unparsed', location: 'Serbia',
      })))).error).toBeNull();
    }
    const last = await subscriber({ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' });
    await jobs();
    await score(db, createRunLog(), caller());
    expect(await stored()).toMatchObject([{ subscriber_id: last.id }]);
  }, 30_000);
});
