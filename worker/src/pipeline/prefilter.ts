import type { Constraints, Enrichment } from '../ai/schemas.js';

export const PREFILTER_REASONS = ['not_remote', 'region', 'salary', 'seniority', 'role'] as const;
type PrefilterReason = (typeof PREFILTER_REASONS)[number];

/** The first violated constraint wins, so each rejected pair is counted once. */
export function prefilterRejectionReason(job: { enrichment: Enrichment }, c: Constraints): PrefilterReason | null {
  const e = job.enrichment;
  if (e.is_remote !== true) return 'not_remote';
  if (!((e.regions.length === 0 && e.countries.length === 0)
    || e.regions.includes('worldwide')
    || e.regions.some((region) => c.regions.includes(region))
    || e.countries.includes(c.country))) return 'region';
  if (c.salary_floor_usd_year !== null && e.salary_usd_year_max !== null
    && e.salary_usd_year_max < c.salary_floor_usd_year) return 'salary';
  if (c.seniority_allowed.length !== 0 && e.seniority !== 'unknown'
    && !c.seniority_allowed.includes(e.seniority)) return 'seniority';
  if (!(c.role_families.length === 0 || c.role_families.includes(e.role_family)
    || (e.role_family === 'fullstack' && (c.role_families.includes('frontend') || c.role_families.includes('backend'))))) return 'role';
  return null;
}

export function passesPrefilter(job: { enrichment: Enrichment }, c: Constraints): boolean {
  return prefilterRejectionReason(job, c) === null;
}
