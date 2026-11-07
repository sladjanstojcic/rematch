import type { SupabaseClient } from '@supabase/supabase-js';
import { CATCHUP_CAP } from '../constants.js';
import type { Database } from '../db.types.js';
import type { SourceName } from '../domain.js';
import { formatSalary, renderDigest, type DigestItem } from '../email/render.js';
import type { Mailer } from '../email/smtp.js';
import { pickLink } from './collect.js';
import { isSubscriberScoreable } from './prompts.js';
import type { RunLog } from './runlog.js';

/** today is computed by the caller in cfg.tz; now is used only for elapsed job age. */
export async function sendDigests(
  db: SupabaseClient<Database>, log: RunLog, mailer: Mailer, ownerEmail: string, today: string, now: Date = new Date(),
): Promise<void> {
  for (const key of ['digest.subscribers', 'digest.sent', 'digest.items', 'digest.failed', 'digest.deferred']) log.inc(key, 0);
  const fail = (message: string) => {
    log.inc('digest.failed');
    log.addError({ stage: 'digest', message });
  };
  const pageSize = 500;
  const subscriberIds: string[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await db.from('subscribers').select('id').eq('active', true)
      .order('id').range(offset, offset + pageSize - 1);
    if (error) { fail('subscribers unavailable'); return; }
    subscriberIds.push(...data.map((s) => s.id));
    if (data.length < pageSize) break;
  }

  for (const subscriberId of subscriberIds) {
    let smtpSucceeded = false;
    try {
      // Recheck the stored hash and day immediately before using this subscriber's matches.
      const { data: subscriber, error } = await db.from('subscribers').select().eq('id', subscriberId).maybeSingle();
      if (error) throw error;
      if (!subscriber || !isSubscriberScoreable(subscriber)) continue;
      log.inc('digest.subscribers');
      if (subscriber.last_digest_on === today) { log.inc('digest.deferred'); continue; }

      const query = () => db.from('matches').select(`id, job_id, score, reason, catchup,
        job:jobs!inner(title, company, salary_min, salary_max, salary_currency, salary_period,
          posted_at, first_seen_at, job_sources(source, url, stale_at))`)
        .eq('subscriber_id', subscriberId).eq('is_match', true).is('emailed_at', null).eq('suppressed', false)
        .eq('job.status', 'open').order('score', { ascending: false }).order('job_id');
      type Selected = NonNullable<Awaited<ReturnType<typeof query>>['data']>[number];
      const selected: Selected[] = [];
      for (let offset = 0; ; offset += pageSize) {
        const { data, error } = await query().range(offset, offset + pageSize - 1);
        if (error) throw error;
        selected.push(...data);
        if (data.length < pageSize) break;
      }
      if (!selected.length) continue;

      const { data: cycle, error: cycleError } = await db.from('catchup_cycles').select('id, closed_at')
        .eq('subscriber_id', subscriberId).order('ordinal', { ascending: false }).limit(1).maybeSingle();
      if (cycleError) throw cycleError;
      const members = new Set<string>();
      if (cycle && cycle.closed_at === null) {
        for (let offset = 0; ; offset += pageSize) {
          const { data, error } = await db.from('catchup_members').select('job_id').eq('cycle_id', cycle.id)
            .order('job_id').range(offset, offset + pageSize - 1);
          if (error) throw error;
          data.forEach((member) => members.add(member.job_id));
          if (data.length < pageSize) break;
        }
      }
      const catchup = selected.some((row) => row.catchup && members.has(row.job_id));
      const sending = catchup ? selected.slice(0, CATCHUP_CAP) : selected;
      const items: DigestItem[] = sending.map(({ job, reason }) => ({
        title: job.title, company: job.company, reason,
        ...pickLink(job.job_sources.map((source) => ({ ...source, source: source.source as SourceName }))),
        salaryText: formatSalary(job),
        dateLabel: job.posted_at === null ? 'First seen' : 'Posted',
        postedDaysAgo: Math.max(0, Math.floor((now.getTime() - Date.parse(job.posted_at ?? job.first_seen_at)) / 86_400_000)),
      }));
      const rendered = renderDigest(subscriber.name, items);
      await mailer({ ...rendered, to: subscriber.email,
        subject: catchup ? `Your catchup list: ${items.length} remote ${items.length === 1 ? 'match' : 'matches'}` : rendered.subject,
        headers: { 'List-Unsubscribe': `<mailto:${ownerEmail}?subject=STOP>`, 'Reply-To': ownerEmail },
      });
      smtpSucceeded = true;
      log.inc('digest.sent');
      log.inc('digest.items', items.length);
      const { error: deliveryError } = await db.rpc('complete_digest_delivery', {
        p_subscriber_id: subscriberId, p_match_ids: sending.map((row) => row.id), p_today: today,
        ...(catchup ? { p_cycle_id: cycle!.id } : {}),
      });
      if (deliveryError) throw deliveryError;
    } catch {
      // SMTP/DB exceptions can contain addresses or prompt text. Never forward their messages.
      fail(`${subscriberId}: ${smtpSucceeded ? 'delivery bookkeeping failed after SMTP success' : 'delivery failed'}`);
    }
  }
}
