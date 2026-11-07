import Anthropic from '@anthropic-ai/sdk';
import type { SupabaseClient } from '@supabase/supabase-js';
import postgres from 'postgres';
import type { StructuredCaller, UsageMeter } from '../ai/client.js';
import type { Config } from '../config.js';
import { DEACTIVATE_DAYS } from '../constants.js';
import type { Database } from '../db.types.js';
import type { Mailer } from '../email/smtp.js';
import { collect } from './collect.js';
import { sendDigests } from './digest.js';
import { enrich } from './enrich.js';
import { refreshPrompts } from './prompts.js';
import { createRunLog } from './runlog.js';
import { score } from './score.js';

// One key shared by scheduled and manual runs, across processes using this DB.
const RUN_LOCK_KEY = 731946028517001n;

export type RunResult = { runId: string | null; status: 'ok' | 'partial' | 'failed' | 'skipped' };
type RunDeps = {
  db: SupabaseClient<Database>; call: StructuredCaller; meter: UsageMeter; mailer: Mailer; cfg: Config; now?: Date;
} & NonNullable<Parameters<typeof collect>[2]>;

export async function runOnce({ db, call, meter, mailer, cfg, now = new Date(), boards, ats }: RunDeps): Promise<RunResult> {
  // Never lend this connection to other work or let its lifetime expire mid-run.
  const sql = postgres(cfg.databaseUrl, { max: 1, idle_timeout: 0, max_lifetime: 0, connect_timeout: 10 });
  try {
    const session = await sql.reserve();
    let acquired = false;
    try {
      const [lock] = await session`select pg_try_advisory_lock(${RUN_LOCK_KEY.toString()}::bigint) as acquired`;
      acquired = lock.acquired;
      if (!acquired) return { runId: null, status: 'skipped' };

      const log = createRunLog();
      const { data: run, error: insertError } = await db.from('runs').insert({ started_at: now.toISOString() }).select('id').single();
      if (insertError) throw new Error('Could not create run record');
      let failed = false;
      const stage = async (name: string, work: () => Promise<unknown>): Promise<boolean> => {
        try { await work(); return true; }
        catch (error) {
          failed = true;
          // SDK and DB exception messages can contain prompts, addresses or credentials.
          const message = error instanceof Anthropic.AuthenticationError ? 'Anthropic authentication failed'
            : error instanceof Anthropic.NotFoundError ? 'Anthropic model or resource not found' : 'Stage failed';
          log.addError({ stage: name, message });
          return false;
        }
      };

      await stage('collect', () => collect(db, log, { boards, ats }));
      await stage('enrich', () => enrich(db, log, call));
      if (await stage('refreshPrompts', () => refreshPrompts(db, log, call))) {
        if (await stage('score', () => score(db, log, call, now))) {
          await stage('sendDigests', () => {
            const today = new Intl.DateTimeFormat('en-CA', {
              timeZone: cfg.tz, year: 'numeric', month: '2-digit', day: '2-digit',
            }).format(now);
            return sendDigests(db, log, mailer, cfg.ownerEmail, today, now);
          });
        }
      }
      await stage('deactivate', async () => {
        const cutoff = new Date(now.getTime() - DEACTIVATE_DAYS * 86_400_000).toISOString();
        const deactivated = await session`update public.companies set active = false
          where active and coalesce(last_remote_job_at, created_at) < ${cutoff}::timestamptz`;
        log.inc('companies.deactivated', deactivated.count);
      });

      const status = failed ? 'failed' : log.errors.length ? 'partial' : 'ok';
      const stats = { ...log.stats, 'ai.failures': meter.failures,
        ...Object.fromEntries(Object.entries(meter.failureReasons).map(([reason, count]) => [`ai.failureReasons.${reason}`, count])),
      };
      const { error: updateError } = await db.from('runs').update({
        finished_at: new Date().toISOString(), status, stats, errors: log.errors,
        input_tokens: meter.inputTokens + meter.cacheWriteTokens + meter.cacheReadTokens,
        output_tokens: meter.outputTokens, est_cost_usd: meter.estCostUsd(),
      }).eq('id', run.id);
      if (updateError) throw new Error('Could not finalize run record');
      return { runId: run.id, status };
    } finally {
      try {
        if (acquired) await session`select pg_advisory_unlock(${RUN_LOCK_KEY.toString()}::bigint)`;
      } finally { session.release(); }
    }
  } finally { await sql.end({ timeout: 5 }); }
}
