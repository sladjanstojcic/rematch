import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb, withTestSql } from './helpers/db.js';

const subscriber = { email: 'reader@example.test', prompt: 'Remote engineering', location: 'Bosnia' };
const job = { dedupe_key: 'fixture-job', title: 'Engineer', company: 'Fixture', description: 'Remote work' };

describe('local database schema', () => {
  beforeEach(resetDb);

  async function fixtures() {
    const db = testDb();
    const { data: reader, error: readerError } = await db.from('subscribers').insert(subscriber).select().single();
    expect(readerError).toBeNull();
    const { data: vacancy, error: vacancyError } = await db.from('jobs').insert(job).select().single();
    expect(vacancyError).toBeNull();
    return { db, reader: reader!, vacancy: vacancy! };
  }

  it('rejects duplicate subscriber/job matches', async () => {
    const { db, reader, vacancy } = await fixtures();
    const match = { subscriber_id: reader.id, job_id: vacancy.id, score: 80, reason: 'Fits', is_match: true };
    expect((await db.from('matches').insert(match)).error).toBeNull();
    expect((await db.from('matches').insert(match)).error?.code).toBe('23505');
  });

  it('rejects duplicate source/external IDs and stores nullable remote hints', async () => {
    const { db, vacancy } = await fixtures();
    const source = { job_id: vacancy.id, source: 'jobicy', external_id: '1', url: 'https://example.test/job' };
    const result = await db.from('job_sources').insert(source).select().single();
    expect(result.error).toBeNull();
    expect(result.data?.remote_hint).toBeNull();
    expect((await db.from('job_sources').insert(source)).error?.code).toBe('23505');
  });

  it('rejects duplicate ATS/slug companies', async () => {
    const db = testDb();
    const company = { name: 'Fixture', ats: 'ashby', slug: 'fixture', discovered_via: 'test' };
    expect((await db.from('companies').insert(company)).error).toBeNull();
    expect((await db.from('companies').insert(company)).error?.code).toBe('23505');
  });

  it('requires subscriber location in the database', async () => {
    await withTestSql(async (sql) => {
      await expect(sql`insert into public.subscribers (email, prompt) values ('missing@example.test', 'Remote')`)
        .rejects.toMatchObject({ code: '23502', column_name: 'location' });
    });
  });

  it('rejects unsupported ATS, job status and enrichment regions', async () => {
    const { db, vacancy } = await fixtures();
    expect((await db.from('companies').insert({ name: 'Bad', ats: 'unsupported', slug: 'bad', discovered_via: 'test' })).error?.code).toBe('23514');
    expect((await db.from('jobs').update({ status: 'invalid' }).eq('id', vacancy.id)).error?.code).toBe('23514');
    expect((await db.from('job_enrichment').insert({ job_id: vacancy.id, is_remote: true, regions: ['invalid'] })).error?.code).toBe('23514');
    expect((await db.from('job_enrichment').insert({ job_id: vacancy.id, is_remote: true, regions: ['europe'], countries: ['BA'] })).error).toBeNull();
  });

  it('retains cohort membership after closure and a late score, excluding jobs collected later', async () => {
    const { db, reader, vacancy } = await fixtures();
    const { data: cycle, error } = await db.from('catchup_cycles').insert({ subscriber_id: reader.id, prompt_hash: 'hash-a' }).select().single();
    expect(error).toBeNull();
    const member = { cycle_id: cycle!.id, job_id: vacancy.id };
    expect((await db.from('catchup_members').insert(member)).error).toBeNull();
    expect((await db.from('catchup_members').insert(member)).error?.code).toBe('23505');
    expect((await db.from('catchup_cycles').update({ closed_at: new Date().toISOString() }).eq('id', cycle!.id)).error).toBeNull();
    expect((await db.from('matches').insert({ subscriber_id: reader.id, job_id: vacancy.id, score: 90, reason: 'Late', is_match: true, catchup: true, suppressed: true })).error).toBeNull();
    expect((await db.from('jobs').insert({ ...job, dedupe_key: 'later-job' })).error).toBeNull();
    const members = await db.from('catchup_members').select('job_id').eq('cycle_id', cycle!.id);
    expect(members.data).toEqual([{ job_id: vacancy.id }]);
    expect((await db.from('subscribers').delete().eq('id', reader.id)).error).toBeNull();
    expect((await db.from('catchup_cycles').select()).data).toEqual([]);
    expect((await db.from('catchup_members').select()).data).toEqual([]);
    expect((await db.from('matches').select()).data).toEqual([]);
  });

  it('allows a new cycle when a prompt changes A to B to A', async () => {
    const { db, reader } = await fixtures();
    const ids: string[] = [];
    for (const hash of ['a', 'b', 'a']) {
      const inserted = await db.from('catchup_cycles').insert({ subscriber_id: reader.id, prompt_hash: hash,
        created_at: '2026-11-05T00:00:00Z' }).select().single();
      expect(inserted.error).toBeNull();
      ids.push(inserted.data!.id);
    }
    const cycles = await db.from('catchup_cycles').select().eq('subscriber_id', reader.id).order('ordinal', { ascending: false });
    expect(cycles.error).toBeNull();
    expect(cycles.data?.map((cycle) => cycle.id)).toEqual([ids[2], ids[1], ids[0]]);
    expect(cycles.data?.map((cycle) => cycle.prompt_hash)).toEqual(['a', 'b', 'a']);
    expect(new Set(cycles.data?.map((cycle) => cycle.id)).size).toBe(3);
  });

  it('persists source attempt times without any jobs or sources', async () => {
    const db = testDb();
    const attempt = { source: 'jobicy', last_attempt_at: '2026-11-05T12:00:00Z' };
    expect((await db.from('source_poll_state').upsert(attempt)).error).toBeNull();
    const saved = await db.from('source_poll_state').select().single();
    expect(saved.data?.last_attempt_at).toBe('2026-11-05T12:00:00+00:00');
    expect((await db.from('job_sources').select()).data).toEqual([]);
    expect((await db.from('source_poll_state').insert(attempt)).error?.code).toBe('23505');
  });

  it('refuses a foreign connection override before any reset and preserves owned data', async () => {
    const { db, reader } = await fixtures();
    vi.stubEnv('DATABASE_URL', 'postgresql://fixture:fixture@192.0.2.1:5432/shared');
    try {
      expect(() => testDb()).toThrow('Refusing mismatched DATABASE_URL');
      await expect(resetDb()).rejects.toThrow('Refusing mismatched DATABASE_URL');
    } finally { vi.unstubAllEnvs(); }
    expect((await db.from('subscribers').select('id').eq('id', reader.id)).data).toEqual([{ id: reader.id }]);
  });

  it('enables RLS on every application table without public policies', async () => {
    await withTestSql(async (sql) => {
      const tables = await sql`select relname, relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' order by relname`;
      expect(tables.map((table) => table.relname)).toEqual(['catchup_cycles', 'catchup_members', 'companies', 'job_enrichment', 'job_sources', 'jobs', 'matches', 'runs', 'source_poll_state', 'subscribers']);
      expect(tables.every((table) => table.relrowsecurity)).toBe(true);
      expect(await sql`select policyname from pg_policies where schemaname = 'public'`).toHaveLength(0);
      for (const role of ['anon', 'authenticated']) {
        await expect(sql.begin(async (tx) => {
          await tx.unsafe(`set local role ${role}`);
          await tx`select * from public.subscribers`;
        })).rejects.toMatchObject({ code: '42501' });
      }
    });
  });
});
