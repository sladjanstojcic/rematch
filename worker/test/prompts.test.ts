import Anthropic from '@anthropic-ai/sdk';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StructuredCaller } from '../src/ai/client.js';
import { ConstraintsSchema, type Constraints } from '../src/ai/schemas.js';
import type { Database } from '../src/db.types.js';
import { freshnessCutoff, freshnessFilter } from '../src/pipeline/job-rules.js';
import { isSubscriberScoreable, refreshPrompts } from '../src/pipeline/prompts.js';
import { createRunLog } from '../src/pipeline/runlog.js';
import { resetDb, testDb, withTestSql } from './helpers/db.js';

const now = new Date('2026-11-06T12:00:00Z');
const boundary = '2026-10-23T12:00:00.000Z';
const old = '2026-10-17T12:00:00Z';
const output: Constraints = {
  salary_floor_usd_year: 80_000, seniority_allowed: ['mid', 'senior'], role_families: ['frontend'],
  country: 'RS', regions: ['europe', 'emea'],
};
type Subscriber = Database['public']['Tables']['subscribers']['Row'];
type JobInsert = Database['public']['Tables']['jobs']['Insert'];
let db: ReturnType<typeof testDb>;
const hash = (prompt: string, location: string) => createHash('sha256').update(`${prompt}\n${location}`).digest('hex');
function caller(value: Constraints | null = output): StructuredCaller {
  return async ({ schema }) => value === null ? null : schema.parse(value);
}
async function subscriber(patch: Partial<Subscriber> = {}) {
  const result = await db.from('subscribers').insert({ email: `${randomUUID()}@example.test`,
    prompt: 'Senior frontend, at least USD 80000/year', location: 'Serbia', ...patch }).select().single();
  expect(result.error).toBeNull();
  return result.data!;
}
async function job(patch: Partial<JobInsert> = {}) {
  const result = await db.from('jobs').insert({ dedupe_key: randomUUID(), title: 'Engineer', company: 'Acme',
    description: 'Remote', first_seen_at: now.toISOString(), ...patch }).select().single();
  expect(result.error).toBeNull();
  return result.data!;
}
async function stored(id: string) {
  const result = await db.from('subscribers').select().eq('id', id).single();
  expect(result.error).toBeNull();
  return result.data!;
}
async function cycles(id: string) {
  const result = await db.from('catchup_cycles').select('*, catchup_members(job_id)').eq('subscriber_id', id).order('ordinal');
  expect(result.error).toBeNull();
  return result.data!;
}
async function match(subscriberId: string, jobId: string, emailed = false, suppressed = false) {
  const result = await db.from('matches').insert({ subscriber_id: subscriberId, job_id: jobId, score: 90,
    reason: 'fixture', is_match: true, emailed_at: emailed ? now.toISOString() : null, suppressed }).select().single();
  expect(result.error).toBeNull();
  return result.data!;
}
async function matches() {
  const result = await db.from('matches').select().order('id');
  expect(result.error).toBeNull();
  return result.data!;
}

it('shares the inclusive 14-day UTC cutoff with the PostgREST filter', () => {
  expect(freshnessCutoff(now)).toBe(boundary);
  expect(freshnessFilter(now)).toBe(`posted_at.gte.${boundary},and(posted_at.is.null,first_seen_at.gte.${boundary})`);
});

describe('refreshPrompts', () => {
  beforeAll(() => { db = testDb(); });
  beforeEach(async () => { await resetDb(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('parses a new subscriber, saves constraints/hash, returns catch-up and skips it next time', async () => {
    const s = await subscriber();
    const log = createRunLog();
    const calls: { system: string; user: string }[] = [];
    expect(await refreshPrompts(db, log, async (args) => {
      calls.push(args);
      expect(args.schema).toBe(ConstraintsSchema);
      return args.schema.parse(output);
    })).toEqual([s.id]);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].user)).toEqual({ prompt: s.prompt, location: s.location });
    expect(await stored(s.id)).toMatchObject({ constraints: output, prompt_hash: hash(s.prompt, s.location) });
    expect(isSubscriberScoreable(await stored(s.id))).toBe(true);
    expect(log.stats).toMatchObject({ 'prompts.checked': 1, 'prompts.refreshed': 1, 'prompts.failed': 0 });
    expect(log.errors).toEqual([]);
    const again = createRunLog();
    let repeatedCalls = 0;
    expect(await refreshPrompts(db, again, async () => { repeatedCalls++; return null; })).toEqual([]);
    expect(repeatedCalls).toBe(0);
    expect(await cycles(s.id)).toHaveLength(1);
    expect(again.stats).toMatchObject({ 'prompts.checked': 1, 'prompts.refreshed': 0, 'prompts.failed': 0 });
  });

  it('uses one fixed system prompt across subscribers and keeps personal input in the user message', async () => {
    await subscriber({ prompt: 'unique-frontend-request', location: 'unique-location-a' });
    await subscriber({ prompt: 'unique-backend-request', location: 'unique-location-b' });
    const systems: string[] = [];
    await refreshPrompts(db, createRunLog(), async ({ schema, system }) => {
      systems.push(system);
      return schema.parse(output);
    });
    expect(systems).toHaveLength(2);
    expect(new Set(systems).size).toBe(1);
    expect(systems[0]).not.toContain('unique-');
  });

  it('changing the prompt removes only this subscriber’s unemailed matches, including suppressed rows', async () => {
    const s = await subscriber();
    await refreshPrompts(db, createRunLog(), caller());
    const other = await subscriber({ active: false });
    const jobs = [await job(), await job(), await job()];
    const sent = await match(s.id, jobs[0].id, true);
    await match(s.id, jobs[1].id);
    await match(s.id, jobs[2].id, false, true);
    const untouched = await match(other.id, jobs[1].id);
    expect((await db.from('subscribers').update({ prompt: 'Now backend' }).eq('id', s.id)).error).toBeNull();
    expect(isSubscriberScoreable(await stored(s.id))).toBe(false);
    expect(await refreshPrompts(db, createRunLog(), caller({ ...output, role_families: ['backend'] }))).toEqual([s.id]);
    expect(await matches()).toEqual([sent, untouched].sort((a, b) => a.id.localeCompare(b.id)));
    expect(await cycles(s.id)).toHaveLength(2);
  });

  it('changing only location triggers a refresh and persists the parsed location', async () => {
    const s = await subscriber();
    await refreshPrompts(db, createRunLog(), caller());
    expect((await db.from('subscribers').update({ location: 'Germany' }).eq('id', s.id)).error).toBeNull();
    expect(isSubscriberScoreable(await stored(s.id))).toBe(false);
    expect(await refreshPrompts(db, createRunLog(), caller({ ...output, country: 'DE', regions: ['europe', 'eu', 'emea'] }))).toEqual([s.id]);
    expect(await stored(s.id)).toMatchObject({ prompt_hash: hash(s.prompt, 'Germany'), constraints: { country: 'DE', regions: ['europe', 'eu', 'emea'] } });
  });

  it('freezes every open in-window job, including unenriched jobs, using posted_at before first_seen_at', async () => {
    const s = await subscriber();
    const posted = await job({ posted_at: boundary, first_seen_at: old });
    const fallback = await job({ posted_at: null, first_seen_at: boundary });
    const enriched = await job();
    expect((await db.from('job_enrichment').insert({ job_id: enriched.id, is_remote: false })).error).toBeNull();
    await job({ posted_at: old });
    await job({ posted_at: null, first_seen_at: old });
    await job({ posted_at: '2026-10-23T11:59:59.999Z' });
    await job({ first_seen_at: '2026-10-23T11:59:59.999Z' });
    await job({ status: 'closed' });
    await refreshPrompts(db, createRunLog(), caller());
    const first = (await cycles(s.id))[0];
    expect(first.catchup_members.map((m) => m.job_id).sort()).toEqual([posted.id, fallback.id, enriched.id].sort());
    expect(first.closed_at).toBeNull();
    await job(); // New jobs cannot join the previous refresh's cohort.
    expect((await db.from('jobs').update({ status: 'closed' }).eq('id', posted.id)).error).toBeNull();
    expect((await db.from('job_enrichment').insert({ job_id: fallback.id, is_remote: true })).error).toBeNull();
    await refreshPrompts(db, createRunLog(), caller());
    expect(await cycles(s.id)).toEqual([first]);
  });

  it('creates a distinct cycle when a previous hash repeats, retaining older frozen membership', async () => {
    const s = await subscriber({ prompt: 'A' });
    const a = await job();
    await refreshPrompts(db, createRunLog(), caller());
    const first = (await cycles(s.id))[0];
    const b = await job();
    expect((await db.from('subscribers').update({ prompt: 'B' }).eq('id', s.id)).error).toBeNull();
    await refreshPrompts(db, createRunLog(), caller());
    expect((await db.from('subscribers').update({ prompt: 'A' }).eq('id', s.id)).error).toBeNull();
    await refreshPrompts(db, createRunLog(), caller());
    const all = await cycles(s.id);
    expect(all).toHaveLength(3);
    expect(new Set(all.map((c) => c.id)).size).toBe(3);
    expect(all[2].ordinal).toBeGreaterThan(all[1].ordinal);
    expect(all[2].prompt_hash).toBe(first.prompt_hash);
    expect(all[0]).toEqual(first);
    expect(all[0].catchup_members.map((m) => m.job_id)).toEqual([a.id]);
    expect(all[2].catchup_members.map((m) => m.job_id).sort()).toEqual([a.id, b.id].sort());
  });

  it('a null parse leaves the old hash, constraints, matches and cohort untouched and retries later', async () => {
    const s = await subscriber();
    await refreshPrompts(db, createRunLog(), caller());
    const m = await match(s.id, (await job()).id);
    const beforeCycles = await cycles(s.id);
    expect((await db.from('subscribers').update({ prompt: 'Changed' }).eq('id', s.id)).error).toBeNull();
    const before = await stored(s.id);
    const log = createRunLog();
    expect(await refreshPrompts(db, log, caller(null))).toEqual([]);
    expect(await stored(s.id)).toEqual(before);
    expect(await matches()).toEqual([m]);
    expect(await cycles(s.id)).toEqual(beforeCycles);
    expect(isSubscriberScoreable(await stored(s.id))).toBe(false);
    expect(log.errors).toEqual([expect.objectContaining({ stage: 'prompts', message: expect.stringContaining(s.id) })]);
    expect(log.stats).toMatchObject({ 'prompts.checked': 1, 'prompts.refreshed': 0, 'prompts.failed': 1 });
    expect(await refreshPrompts(db, createRunLog(), caller())).toEqual([s.id]);
    expect(isSubscriberScoreable(await stored(s.id))).toBe(true);
  });

  it('isolates an ordinary caller failure and still refreshes another subscriber', async () => {
    const failed = await subscriber({ prompt: 'fail' });
    const good = await subscriber({ prompt: 'ok' });
    const log = createRunLog();
    expect(await refreshPrompts(db, log, async ({ schema, user }) => {
      if (JSON.parse(user).prompt === 'fail') throw new Error('fixture failure');
      return schema.parse(output);
    })).toEqual([good.id]);
    expect((await stored(failed.id)).prompt_hash).toBeNull();
    expect(log.stats).toMatchObject({ 'prompts.checked': 2, 'prompts.refreshed': 1, 'prompts.failed': 1 });
    expect(log.errors).toHaveLength(1);
  });

  it.each([
    new Anthropic.AuthenticationError(401, {}, 'bad key', new Headers()),
    new Anthropic.NotFoundError(404, {}, 'bad model', new Headers()),
  ])('propagates a configuration fault to the orchestrator: %s', async (error) => {
    const s = await subscriber();
    await expect(refreshPrompts(db, createRunLog(), async () => { throw error; })).rejects.toBe(error);
    expect(await stored(s.id)).toEqual(s);
    expect(await cycles(s.id)).toEqual([]);
  });

  it('does not parse inactive subscribers', async () => {
    const s = await subscriber({ active: false });
    let calls = 0;
    expect(await refreshPrompts(db, createRunLog(), async () => { calls++; return null; })).toEqual([]);
    expect(calls).toBe(0);
    expect(await stored(s.id)).toEqual(s);
  });

  it.each([{ prompt: 'edited while parsing' }, { location: 'edited while parsing' }, { active: false }])(
    'does not commit a parse if the subscriber changed during the AI call: %j', async (patch) => {
      const s = await subscriber();
      const m = await match(s.id, (await job()).id);
      expect(await refreshPrompts(db, createRunLog(), async ({ schema }) => {
        expect((await db.from('subscribers').update(patch).eq('id', s.id)).error).toBeNull();
        return schema.parse(output);
      })).toEqual([]);
      expect((await stored(s.id)).prompt_hash).toBeNull();
      expect(await matches()).toEqual([m]);
      expect(await cycles(s.id)).toEqual([]);
    },
  );

  it('rolls back hash, constraints, match deletion and cycle when member insertion fails', async () => {
    const s = await subscriber();
    await refreshPrompts(db, createRunLog(), caller());
    const m = await match(s.id, (await job()).id);
    expect((await db.from('subscribers').update({ prompt: 'Changed' }).eq('id', s.id)).error).toBeNull();
    const before = await stored(s.id);
    const beforeCycles = await cycles(s.id);
    await withTestSql(async (sql) => {
      await sql`create function public.t7_reject_member() returns trigger language plpgsql as $$
        begin raise exception 'fixture member insert failure'; end; $$`;
      try {
        await sql`create trigger t7_reject_member before insert on public.catchup_members
          for each row execute function public.t7_reject_member()`;
        const log = createRunLog();
        expect(await refreshPrompts(db, log, caller({ ...output, salary_floor_usd_year: 100_000 }))).toEqual([]);
        expect(await stored(s.id)).toEqual(before);
        expect(await matches()).toEqual([m]);
        expect(await cycles(s.id)).toEqual(beforeCycles);
        expect(log.stats['prompts.failed']).toBe(1);
        expect(log.errors[0]).toMatchObject({ stage: 'prompts', message: expect.stringContaining('fixture member insert failure') });
      } finally {
        await sql`drop trigger if exists t7_reject_member on public.catchup_members`;
        await sql`drop function public.t7_reject_member()`;
      }
    });
    expect(await refreshPrompts(db, createRunLog(), caller())).toEqual([s.id]);
  });

  it('concurrent refresh attempts commit only one cycle for the same current input', async () => {
    const s = await subscriber();
    const j = await job();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let calls = 0;
    const call: StructuredCaller = async ({ schema }) => {
      if (++calls === 2) release();
      await gate;
      return schema.parse(output);
    };
    const results = await Promise.all([refreshPrompts(db, createRunLog(), call), refreshPrompts(db, createRunLog(), call)]);
    expect(results.flat()).toEqual([s.id]);
    const all = await cycles(s.id);
    expect(all).toHaveLength(1);
    expect(all[0].catchup_members).toEqual([{ job_id: j.id }]);
  });

  it('does not truncate subscribers or cohort membership at the API row limit', async () => {
    await withTestSql(async (sql) => {
      const sameHash = hash('same', 'RS');
      await sql`insert into public.subscribers (id, email, prompt, location, prompt_hash, constraints)
        select ('00000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid, 'page-' || i || '@example.test',
          'same', 'RS', ${sameHash}, ${sql.json(output)} from generate_series(1, 1001) i`;
      await sql`insert into public.jobs (dedupe_key, title, company, description, first_seen_at)
        select 'page-' || i, 'Engineer', 'Acme', 'Remote', ${now.toISOString()}::timestamptz from generate_series(1, 1001) i`;
    });
    const s = await subscriber({ id: 'ffffffff-ffff-ffff-ffff-ffffffffffff' });
    const log = createRunLog();
    expect(await refreshPrompts(db, log, caller())).toEqual([s.id]);
    const result = await db.from('catchup_members').select('*', { count: 'exact', head: true });
    expect(result.error).toBeNull();
    expect(result.count).toBe(1001);
    expect(log.stats).toMatchObject({ 'prompts.checked': 1002, 'prompts.refreshed': 1 });
  });

  it('restricts the RPC to service_role and uses invoker rights', async () => {
    const result = await withTestSql(async (sql) => sql`
      select p.prosecdef, p.proconfig,
        has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
        has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'refresh_subscriber_prompt'`);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ prosecdef: false, anon: false, authenticated: false, service_role: true });
    expect(result[0].proconfig).toContain('search_path=""');
  });
});

describe('isSubscriberScoreable', () => {
  const s = { prompt: 'A', location: 'RS', prompt_hash: hash('A', 'RS'), constraints: output, active: true };
  it('requires the current prompt and location hash plus parsed constraints and active status', () => {
    expect(isSubscriberScoreable(s)).toBe(true);
    for (const patch of [{ prompt: 'B' }, { location: 'DE' }, { prompt_hash: null }, { constraints: null }, { active: false }]) {
      expect(isSubscriberScoreable({ ...s, ...patch })).toBe(false);
    }
  });
});
