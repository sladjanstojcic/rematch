import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '../src/db.types.js';
import type { Mailer } from '../src/email/smtp.js';
import { sendDigests } from '../src/pipeline/digest.js';
import { createRunLog } from '../src/pipeline/runlog.js';
import { resetDb, testDb, withTestSql } from './helpers/db.js';

const now = new Date('2026-11-06T23:30:00Z');
const today = '2026-11-07'; // Caller is in Europe/Belgrade; UTC still has the previous date.
const owner = 'owner@example.test';
type Subscriber = Database['public']['Tables']['subscribers']['Row'];
type Job = Database['public']['Tables']['jobs']['Row'];
type Match = Database['public']['Tables']['matches']['Insert'];
let db: ReturnType<typeof testDb>;
let sent: Parameters<Mailer>[0][];
const mailer: Mailer = async (message) => { sent.push(message); };

async function subscriber(patch: Partial<Subscriber> = {}) {
  const prompt = 'private fixture prompt';
  const location = 'Serbia';
  const result = await db.from('subscribers').insert({ email: `${randomUUID()}@example.test`, name: 'Sam', prompt, location,
    prompt_hash: createHash('sha256').update(`${prompt}\n${location}`).digest('hex'), constraints: {}, ...patch }).select().single();
  expect(result.error).toBeNull();
  return result.data!;
}
async function jobs(count: number, patch: Partial<Job> = {}) {
  const all: Job[] = [];
  for (let offset = 0; offset < count; offset += 500) {
    const result = await db.from('jobs').insert(Array.from({ length: Math.min(500, count - offset) }, (_, i) => ({
      dedupe_key: randomUUID(), title: `Job ${i}`, company: 'Acme', description: 'Fixture',
      first_seen_at: '2026-11-04T23:30:00Z', ...patch,
    }))).select();
    expect(result.error).toBeNull();
    expect((await db.from('job_sources').insert(result.data!.flatMap((j) => [
      { job_id: j.id, source: 'remoteok', external_id: randomUUID(), url: `https://remoteok.com/remote-jobs/${j.id}` },
      { job_id: j.id, source: 'greenhouse', external_id: randomUUID(), url: `https://boards.greenhouse.io/fixture/jobs/${j.id}` },
    ]))).error).toBeNull();
    all.push(...result.data!);
  }
  return all;
}
async function matches(s: Subscriber, rows: Job[], patch: Partial<Match> = {}) {
  expect((await db.from('matches').insert(rows.map((j, i) => ({ subscriber_id: s.id, job_id: j.id,
    score: 100 - i % 25, reason: `Reason ${j.id}`, is_match: true, ...patch })))).error).toBeNull();
}
async function cycle(s: Subscriber, rows: Job[], closed = false, created_at?: string) {
  const result = await db.from('catchup_cycles').insert({ subscriber_id: s.id, prompt_hash: s.prompt_hash!,
    closed_at: closed ? now.toISOString() : null, ...(created_at ? { created_at } : {}) }).select().single();
  expect(result.error).toBeNull();
  if (rows.length) expect((await db.from('catchup_members').insert(rows.map((j) => ({
    cycle_id: result.data!.id, job_id: j.id,
  })))).error).toBeNull();
  return result.data!;
}
async function state(s: Subscriber) {
  const [m, sub, cycles] = await Promise.all([
    db.from('matches').select().eq('subscriber_id', s.id).order('score', { ascending: false }).order('job_id'),
    db.from('subscribers').select().eq('id', s.id).single(),
    db.from('catchup_cycles').select().eq('subscriber_id', s.id).order('ordinal'),
  ]);
  expect([m.error, sub.error, cycles.error]).toEqual([null, null, null]);
  return { matches: m.data!, subscriber: sub.data!, cycles: cycles.data! };
}

describe('sendDigests', () => {
  beforeAll(() => { db = testDb(); });
  beforeEach(async () => { await resetDb(); sent = []; vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('sends three ranked items, original credits, salary, age and headers, then records delivery', async () => {
    const s = await subscriber();
    const rows = await jobs(3, { salary_min: 230000, salary_max: 252000, salary_currency: 'USD', salary_period: 'year',
      posted_at: '2026-11-03T23:30:01Z' });
    await matches(s, rows);
    const log = createRunLog();
    vi.setSystemTime(new Date('2027-01-01T00:00:00Z')); // Explicit run now is the age authority.
    await sendDigests(db, log, mailer, owner, today, now);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: s.email, subject: '3 new remote matches for you',
      headers: { 'List-Unsubscribe': '<mailto:owner@example.test?subject=STOP>', 'Reply-To': owner } });
    expect(sent[0].text).toContain('$230K–$252K / year');
    expect(sent[0].text).toContain('Posted 2 days ago');
    expect(sent[0].html).not.toContain('nofollow');
    for (const j of rows) {
      expect(sent[0].html).toContain(`href="https://boards.greenhouse.io/fixture/jobs/${j.id}"`);
      expect(sent[0].text).toContain(`https://remoteok.com/remote-jobs/${j.id}`);
      expect(sent[0].text).toContain(`Reason ${j.id}`);
    }
    expect(sent[0].text.indexOf('Job 0')).toBeLessThan(sent[0].text.indexOf('Job 1'));
    const saved = await state(s);
    expect(saved.matches.every((m) => m.emailed_at !== null && !m.suppressed)).toBe(true);
    expect(saved.subscriber.last_digest_on).toBe(today);
    expect(log.errors).toEqual([]);
    expect(log.stats).toMatchObject({ 'digest.subscribers': 1, 'digest.sent': 1, 'digest.items': 3, 'digest.failed': 0, 'digest.deferred': 0 });
  });

  it('links and credits only live sources when the ATS source has gone stale', async () => {
    const s = await subscriber();
    const rows = await jobs(1);
    await matches(s, rows);
    expect((await db.from('job_sources').update({ stale_at: '2026-11-05T00:00:00Z' })
      .eq('job_id', rows[0].id).eq('source', 'greenhouse')).error).toBeNull();
    await sendDigests(db, createRunLog(), mailer, owner, today, now);
    expect(sent).toHaveLength(1);
    expect(sent[0].html).toContain(`href="https://remoteok.com/remote-jobs/${rows[0].id}"`);
    expect(sent[0].html).not.toContain('boards.greenhouse.io');
    expect(sent[0].text).not.toContain('Greenhouse');
  });

  it.each([1, 2])('pluralizes a %s-item catch-up subject and distinguishes first-seen age from publication', async (count) => {
    const s = await subscriber({ name: null });
    const rows = await jobs(count, { first_seen_at: '2026-11-05T23:30:00Z' });
    await cycle(s, rows);
    await matches(s, rows, { catchup: true });
    await sendDigests(db, createRunLog(), mailer, owner, today, now);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe(count === 1 ? 'Your catchup list: 1 remote match' : 'Your catchup list: 2 remote matches');
    for (const part of [sent[0].html, sent[0].text]) {
      expect(part).toContain('First seen 1 day ago');
      expect(part).not.toContain('Posted');
      expect(part).toContain('Hi there,');
    }
  });

  it('defers new matches on the same caller date and sends them tomorrow without repeating old rows', async () => {
    const s = await subscriber();
    await matches(s, await jobs(1));
    await sendDigests(db, createRunLog(), mailer, owner, today);
    const [next] = await jobs(1, { title: 'Tomorrow job' });
    await matches(s, [next]);
    const log = createRunLog();
    await sendDigests(db, log, mailer, owner, today);
    expect(sent).toHaveLength(1);
    expect(log.stats['digest.deferred']).toBe(1);
    expect((await state(s)).matches.find((m) => m.job_id === next.id)?.emailed_at).toBeNull();
    await sendDigests(db, createRunLog(), mailer, owner, '2026-11-08');
    expect(sent).toHaveLength(2);
    expect(sent[1].subject).toBe('1 new remote match for you');
    expect(sent[1].text).toContain('Tomorrow job');
    expect((await state(s)).subscriber.last_digest_on).toBe('2026-11-08');
  });

  it('skips inactive, stale-hash and unparsed subscribers and empty/non-match/closed/suppressed/emailed selections', async () => {
    for (const patch of [{ active: false }, { prompt_hash: 'stale' }, { constraints: null }]) {
      await matches(await subscriber(patch), await jobs(1));
    }
    const s = await subscriber();
    await matches(s, await jobs(1), { is_match: false });
    await matches(s, await jobs(1, { status: 'closed' }));
    await matches(s, await jobs(1), { suppressed: true });
    await matches(s, await jobs(1), { emailed_at: now.toISOString() });
    await subscriber();
    const before = await state(s);
    await sendDigests(db, createRunLog(), mailer, owner, today);
    expect(sent).toEqual([]);
    expect(await state(s)).toEqual(before);
  });

  it('keeps SMTP failures unchanged and private, then continues with the next subscriber', async () => {
    const a = await subscriber({ id: '00000000-0000-0000-0000-000000000001' });
    const b = await subscriber({ id: '00000000-0000-0000-0000-000000000002' });
    const rows = await jobs(20);
    await cycle(a, rows);
    await matches(a, rows, { catchup: true });
    await matches(b, await jobs(1));
    const before = await state(a);
    const log = createRunLog();
    await sendDigests(db, log, async (message) => {
      if (message.to === a.email) throw new Error(`${a.email} ${a.prompt}`);
      await mailer(message);
    }, owner, today);
    expect(await state(a)).toEqual(before);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(b.email);
    expect(log.errors).toEqual([{ stage: 'digest', message: `${a.id}: delivery failed` }]);
    expect(log.stats).toMatchObject({ 'digest.failed': 1, 'digest.sent': 1, 'digest.items': 1 });
  });

  it('closes a 20-item catch-up, sends the top 15, suppresses leftovers and late scores only in that cohort', async () => {
    const s = await subscriber();
    const rows = await jobs(21);
    await cycle(s, rows);
    await matches(s, rows.slice(0, 20), { catchup: true });
    const [outside] = await jobs(1, { title: 'Outside cohort' });
    await matches(s, [outside], { score: 70 });
    await sendDigests(db, createRunLog(), mailer, owner, today);
    expect(sent[0].subject).toBe('Your catchup list: 15 remote matches');
    const saved = await state(s);
    expect(saved.matches.filter((m) => m.emailed_at)).toHaveLength(15);
    expect(saved.matches.filter((m) => m.suppressed).map((m) => m.job_id).sort()).toEqual(rows.slice(15, 20).map((j) => j.id).sort());
    expect(saved.cycles[0].closed_at).not.toBeNull();
    expect(saved.matches.find((m) => m.job_id === outside.id)).toMatchObject({ emailed_at: null, suppressed: false });
    const late = await db.rpc('insert_scored_matches', { p_subscriber_id: s.id, p_prompt: s.prompt, p_location: s.location,
      p_prompt_hash: s.prompt_hash!, p_results: [{ job_id: rows[20].id, score: 99, reason: 'Late score', is_match: true }] });
    expect(late.error).toBeNull();
    expect((await state(s)).matches.find((m) => m.job_id === rows[20].id)).toMatchObject({ catchup: true, suppressed: true, emailed_at: null });
    await sendDigests(db, createRunLog(), mailer, owner, '2026-11-08');
    expect(sent[1].subject).toBe('1 new remote match for you');
    expect(sent[1].text).toContain('Outside cohort');
  });

  it('detects catch-up from all selected rows even when its only selected member ranks below the cap', async () => {
    const s = await subscriber();
    const members = await jobs(1);
    await cycle(s, members);
    await matches(s, members, { catchup: true, score: 70 });
    await matches(s, await jobs(16));
    await sendDigests(db, createRunLog(), mailer, owner, today);
    expect(sent[0].subject).toBe('Your catchup list: 15 remote matches');
    const saved = await state(s);
    expect(saved.cycles[0].closed_at).not.toBeNull();
    expect(saved.matches.filter((m) => m.suppressed).map((m) => m.job_id)).toEqual([members[0].id]);
    expect(saved.matches.filter((m) => m.emailed_at === null && !m.suppressed)).toHaveLength(1);
  });

  it.each([false, true])('uses newest ordinal, not created_at or old flags, with latest closed=%s', async (closed) => {
    const s = await subscriber();
    const rows = await jobs(20);
    await cycle(s, rows, false, '2026-11-06T00:00:00Z');
    const latest = await cycle(s, closed ? rows : [], closed, '2026-11-01T00:00:00Z');
    await matches(s, rows, { catchup: true });
    await sendDigests(db, createRunLog(), mailer, owner, today);
    expect(sent[0].subject).toBe('20 new remote matches for you');
    const saved = await state(s);
    expect(saved.matches.filter((m) => m.emailed_at)).toHaveLength(20);
    expect(saved.cycles[0].closed_at).toBeNull();
    expect(saved.cycles[1].closed_at).toBe(latest.closed_at);
  });

  it('uses job id to break equal scores and first_seen_at when posted_at is missing', async () => {
    const s = await subscriber();
    const rows = await jobs(2);
    await matches(s, rows, { score: 80 });
    await sendDigests(db, createRunLog(), mailer, owner, today);
    const ordered = rows.toSorted((a, b) => a.id.localeCompare(b.id));
    expect(sent[0].text.indexOf(ordered[0].id)).toBeLessThan(sent[0].text.indexOf(ordered[1].id));
    expect(sent[0].text).toContain('First seen 2 days ago');
    expect(sent[0].html).toContain('First seen 2 days ago');
  });

  it('rolls back every bookkeeping change on DB failure after SMTP and reports the subscriber id', async () => {
    const s = await subscriber();
    const rows = await jobs(20);
    await cycle(s, rows);
    await matches(s, rows, { catchup: true });
    const before = await state(s);
    await withTestSql(async (sql) => {
      await sql.begin(async (tx) => {
        await tx`create function public.t9_reject_delivery() returns trigger language plpgsql as $$
          begin raise exception 'private fixture@example.test prompt'; end $$`;
        await tx`create trigger t9_reject_delivery before update of last_digest_on on public.subscribers
          for each row execute function public.t9_reject_delivery()`;
      });
    });
    const log = createRunLog();
    try {
      await sendDigests(db, log, mailer, owner, today);
      expect(sent).toHaveLength(1);
      expect(await state(s)).toEqual(before);
      expect(log.errors).toEqual([{ stage: 'digest', message: `${s.id}: delivery bookkeeping failed after SMTP success` }]);
      expect(log.stats).toMatchObject({ 'digest.sent': 1, 'digest.items': 15, 'digest.failed': 1 });
    } finally {
      await withTestSql(async (sql) => {
        await sql`drop trigger t9_reject_delivery on public.subscribers`;
        await sql`drop function public.t9_reject_delivery()`;
      });
    }
  });

  it('paginates matches beyond the Data API row limit without dropping or duplicating deliveries', async () => {
    const s = await subscriber();
    const rows = await jobs(1001);
    await matches(s, rows);
    await sendDigests(db, createRunLog(), mailer, owner, today);
    expect(sent[0].subject).toBe('1001 new remote matches for you');
    const count = await db.from('matches').select('id', { count: 'exact', head: true }).not('emailed_at', 'is', null);
    expect(count.error).toBeNull();
    expect(count.count).toBe(1001);
  });
});

it('restricts atomic delivery bookkeeping to service_role with invoker rights and an empty search path', async () => {
  await withTestSql(async (sql) => {
    const rows = await sql`select p.prosecdef, p.proconfig,
      has_function_privilege('anon', p.oid, 'execute') as anon,
      has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
      has_function_privilege('service_role', p.oid, 'execute') as service
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = 'complete_digest_delivery'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ prosecdef: false, proconfig: ['search_path=""'], anon: false, authenticated: false, service: true });
  });
});
