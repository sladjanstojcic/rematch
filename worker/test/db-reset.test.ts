import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDb, testDb } from './helpers/db.js';

const sentinel = 'reset-guard@example.com';

describe('test database reset protection', () => {
  beforeEach(async () => {
    vi.stubEnv('REMATCH_ALLOW_TEST_RESET', '');
    await resetDb();
  });
  afterEach(async () => {
    // Remove only this test's sentinel, even when the refusal assertion fails.
    expect((await testDb().from('subscribers').delete().eq('email', sentinel)).error).toBeNull();
    vi.unstubAllEnvs();
  });

  it.each(['', '0', 'true'])('preserves non-fixture subscribers and delivery history with override %j', async (override) => {
    const db = testDb();
    const { data: s, error } = await db.from('subscribers').insert({ email: sentinel,
      prompt: 'Remote engineering', location: 'Bosnia' }).select().single();
    expect(error).toBeNull();
    const { data: j, error: jobError } = await db.from('jobs').insert({ dedupe_key: 'reset-guard',
      title: 'Engineer', company: 'Fixture', description: 'Remote' }).select().single();
    expect(jobError).toBeNull();
    const match = { subscriber_id: s!.id, job_id: j!.id, score: 80, reason: 'Fits',
      is_match: true, emailed_at: '2026-11-06T07:00:00+00:00' };
    expect((await db.from('matches').insert(match)).error).toBeNull();
    vi.stubEnv('REMATCH_ALLOW_TEST_RESET', override);
    await expect(resetDb()).rejects.toThrow('REMATCH_ALLOW_TEST_RESET=1');
    expect((await db.from('subscribers').select('id')).data).toEqual([{ id: s!.id }]);
    expect((await db.from('matches').select()).data).toMatchObject([match]);
  });

  it('allows disposable fixture subscribers without an override', async () => {
    const db = testDb();
    expect((await db.from('subscribers').insert({ email: 'fixture@example.test',
      prompt: 'Remote', location: 'Bosnia' })).error).toBeNull();
    await resetDb();
    expect((await db.from('subscribers').select()).data).toEqual([]);
  });

  it('allows an explicitly authorized reset with override exactly 1', async () => {
    const db = testDb();
    expect((await db.from('subscribers').insert({ email: sentinel,
      prompt: 'Remote', location: 'Bosnia' })).error).toBeNull();
    vi.stubEnv('REMATCH_ALLOW_TEST_RESET', '1');
    await resetDb();
    expect((await db.from('subscribers').select()).data).toEqual([]);
  });
});
