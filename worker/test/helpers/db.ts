import type { SupabaseClient } from '@supabase/supabase-js';
import postgres, { type Sql } from 'postgres';
import { ownedLocalConnection } from '../../../supabase/local-db.mjs';
import { loadConfig } from '../../src/config.js';
import { createDb } from '../../src/db.js';
import type { Database } from '../../src/db.types.js';

/** All target data comes from the CLI after receipt, Docker identity and loopback checks. */
export function testDb(): SupabaseClient<Database> {
  const { apiUrl, serviceRoleKey, databaseUrl } = ownedLocalConnection();
  return createDb(loadConfig({
    SUPABASE_URL: apiUrl, SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey, DATABASE_URL: databaseUrl,
    ANTHROPIC_API_KEY: 'unused-test-fixture', OWNER_EMAIL: 'fixture@example.test',
  }));
}

export async function withTestSql<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
  const { databaseUrl } = ownedLocalConnection();
  const sql = postgres(databaseUrl, { max: 1, connect_timeout: 5 });
  try { return await fn(sql); } finally { await sql.end({ timeout: 5 }); }
}

/** Truncate application tables only; preserve Supabase's auth/storage/system schemas. */
export async function resetDb(): Promise<void> {
  await withTestSql(async (sql) => {
    if (process.env.REMATCH_ALLOW_TEST_RESET !== '1') {
      const [row] = await sql`select count(*) as count from public.subscribers
        where email not like '%@example.test'`;
      if (Number(row!.count) > 0) {
        throw new Error('Refusing to reset non-fixture subscribers; set REMATCH_ALLOW_TEST_RESET=1 only to discard their delivery history');
      }
    }
    await sql`truncate table public.catchup_members, public.catchup_cycles,
      public.source_poll_state, public.matches, public.job_enrichment,
      public.job_sources, public.jobs, public.companies, public.subscribers, public.runs`;
  });
}
