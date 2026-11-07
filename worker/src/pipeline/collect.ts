import type { SupabaseClient } from '@supabase/supabase-js';
import pLimit from 'p-limit';
import { AI_CONCURRENCY, DEAD_BOARD_404_RUNS } from '../constants.js';
import type { Database } from '../db.types.js';
import type { AtsName, RawJob, SourceName } from '../domain.js';
import { boardAdapters, atsAdapters } from '../sources/registry.js';
import { credit, type AtsAdapter, type BoardAdapter } from '../sources/types.js';
import { HttpError } from '../util/http.js';
import { normalizeKey } from '../util/text.js';
import type { RunLog } from './runlog.js';

const atsPriority: AtsName[] = ['ashby', 'greenhouse', 'lever', 'recruitee'];
const boardPriority = ['jobicy', 'wwr', 'remoteok', 'arbeitnow', 'hn'] as const;
const priority: SourceName[] = [...atsPriority, ...boardPriority];

export function pickLink(sources: { source: SourceName; url: string; stale_at?: string | null }[]): {
  url: string; credits: { name: string; url: string }[];
} {
  // A stale ATS source was missing from a successful fetch or its board returned
  // 404, so its link is likely dead. Use it only if no live source remains.
  const live = sources.filter((item) => item.stale_at == null);
  const usable = live.length ? live : sources;
  const ordered = priority.flatMap((source) => {
    const entry = usable.find((item) => item.source === source);
    return entry ? [{ name: credit[source].name, url: entry.url }] : [];
  });
  if (!ordered.length) throw new Error('No supported source link');
  return { url: ordered[0].url, credits: ordered };
}

export async function collect(
  db: SupabaseClient<Database>,
  log: RunLog,
  deps: { boards?: BoardAdapter[]; ats?: Record<AtsName, AtsAdapter> } = {},
): Promise<void> {
  log.inc('collect_dead_boards', 0);
  const startedAt = new Date().toISOString();
  const limit = pLimit(AI_CONCURRENCY);
  const report = (source: string | undefined, error: unknown, slug?: string) => {
    const message = error instanceof Error ? error.message
      : typeof error === 'object' && error !== null && 'message' in error ? String(error.message) : String(error);
    // One bounded single-line policy for every collect error, whatever its source.
    const text = message.replace(/\s+/g, ' ').trim().slice(0, 200);
    log.addError({ stage: 'collect', ...(source ? { source } : {}), message: slug === undefined ? text : `${slug}: ${text}` });
  };
  const store = async (source: SourceName, jobs: RawJob[], companyId?: string) => {
    const items = jobs.map((job) => {
      if (job.source !== source) throw new Error(`Unexpected source in ${source} batch`);
      return {
        external_id: job.externalId, url: job.url, apply_url: job.applyUrl,
        collect_key: normalizeKey(job.company, job.title), title: job.title, company: job.company,
        location_text: job.locationText, description: job.descriptionText, remote_hint: job.remoteHint,
        posted_at: job.postedAt?.toISOString() ?? null,
        salary_min: job.salary?.min ?? null, salary_max: job.salary?.max ?? null,
        salary_currency: job.salary?.currency ?? null, salary_period: job.salary?.period ?? null,
        company_ats: job.companyAts?.ats ?? null, company_slug: job.companyAts?.slug ?? null,
      };
    });
    const { data, error } = await db.rpc('collect_source_batch', {
      p_source: source, p_items: items, p_started_at: startedAt, ...(companyId ? { p_company_id: companyId } : {}),
    });
    if (error) throw error;
    const counts = data as { upserted: number; closed: number; discovered: number };
    log.inc('collect_upserted', counts.upserted);
    log.inc('collect_closed', counts.closed);
    log.inc('collect_discovered', counts.discovered);
  };

  await Promise.all((deps.boards ?? boardAdapters).map((adapter) => limit(async () => {
    try {
      if (!boardPriority.includes(adapter.name)) throw new Error(`Unsupported board: ${adapter.name}`);
      if (adapter.name === 'jobicy') {
        const { data: claimed, error } = await db.rpc('claim_jobicy_poll');
        if (error) throw error;
        if (!claimed) { log.inc('collect_skipped_polls'); return; }
      }
      const jobs = await adapter.fetchJobs((issue) => {
        report(issue.source, issue.message);
        log.inc('collect_skipped_records', issue.skipped);
      });
      await store(adapter.name, jobs);
    } catch (error) { report(adapter.name, error); }
  })));

  // Discovery committed by boards is visible to this run's ATS phase.
  const companies: Pick<Database['public']['Tables']['companies']['Row'], 'id' | 'ats' | 'slug' | 'name' | 'not_found_runs'>[] = [];
  const pageSize = 500; // Below the configured Data API cap of 1,000 rows.
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await db.from('companies').select('id, ats, slug, name, not_found_runs')
      .eq('active', true).order('id').range(offset, offset + pageSize - 1);
    if (error) { report(undefined, error); return; }
    companies.push(...data);
    if (data.length < pageSize) break;
  }
  const ats = deps.ats ?? atsAdapters;
  // A 404 is evidence the board's listings are gone: close them now through the
  // successful-absence rule (a later successful fetch reopens them). Only
  // consecutive 404s retire the company, so one bad response is not final.
  const notFound = async (company: (typeof companies)[number]) => {
    try { await store(company.ats as AtsName, [], company.id); }
    catch (error) { report(company.ats, error, company.slug); }
    const runs = company.not_found_runs + 1;
    const dead = runs >= DEAD_BOARD_404_RUNS;
    const { error } = await db.from('companies')
      .update({ not_found_runs: runs, ...(dead ? { active: false } : {}) }).eq('id', company.id);
    if (error) report(company.ats, dead ? 'Dead board deactivation failed' : 'Not-found counter update failed', company.slug);
    else if (dead) log.inc('collect_dead_boards');
  };
  await Promise.all(companies.map((company) => limit(async () => {
    try {
      if (!atsPriority.includes(company.ats as AtsName)) throw new Error(`Unsupported ATS: ${company.ats}`);
      const adapter = ats[company.ats as AtsName];
      if (!adapter || adapter.ats !== company.ats) throw new Error(`Missing ATS adapter: ${company.ats}`);
      const jobs = await adapter.fetchCompany(company.slug, company.name, (issue) => {
        report(issue.source, issue.message, company.slug);
        log.inc('collect_skipped_records', issue.skipped);
      });
      await store(adapter.ats, jobs, company.id);
      if (company.not_found_runs > 0) {
        const { error } = await db.from('companies').update({ not_found_runs: 0 }).eq('id', company.id);
        if (error) report(company.ats, 'Not-found counter reset failed', company.slug);
      }
    } catch (error) {
      report(company.ats, error, company.slug);
      // Lever emits this only after its EU fallback also fails.
      if (error instanceof HttpError && error.status === 404) await notFound(company);
    }
  })));
}
