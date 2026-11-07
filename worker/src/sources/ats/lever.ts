import { z } from 'zod';
import type { RawJob } from '../../domain.js';
import { fetchJson, HttpError } from '../../util/http.js';
import { htmlToText } from '../../util/text.js';
import { createItemIssues, parseEnvelope } from '../itemIssues.js';
import type { AtsAdapter } from '../types.js';

const responseSchema = z.array(z.unknown());
const itemSchema = z.object({
  id: z.string().min(1),
  text: z.string().trim().min(1),
  hostedUrl: z.url({ protocol: /^https?$/ }),
  applyUrl: z.url({ protocol: /^https?$/ }).nullish(),
  description: z.string(),
  lists: z.array(z.object({ text: z.string(), content: z.string() })).nullish(),
  additional: z.string().nullish(),
  salaryDescription: z.string().nullish(),
  categories: z.object({ location: z.string().nullish() }).nullish(),
  workplaceType: z.enum(['remote', 'hybrid', 'onsite', 'on-site', 'unspecified']).nullish(),
  salaryRange: z.object({
    min: z.number().nullish(), max: z.number().nullish(),
    currency: z.string().nullish(), interval: z.string().nullish(),
  }).nullish(),
});

const periods = new Map<string, NonNullable<RawJob['salary']>['period']>([
  ['per-year-salary', 'year'], ['per-month-salary', 'month'], ['per-hour-wage', 'hour'],
]);

export const lever: AtsAdapter = {
  ats: 'lever',
  async fetchCompany(slug, companyName, onIssue) {
    const path = `/v0/postings/${encodeURIComponent(slug)}?mode=json`;
    let data: unknown;
    try {
      data = await fetchJson<unknown>(`https://api.lever.co${path}`);
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 404) throw error;
      data = await fetchJson<unknown>(`https://api.eu.lever.co${path}`);
    }
    const issues = createItemIssues('lever', onIssue);
    const items = parseEnvelope('Lever', responseSchema, data);
    return issues.finish(items.flatMap((item) => issues.parse(itemSchema, item) ?? []).map((job): RawJob => ({
      source: 'lever', externalId: job.id, url: job.hostedUrl, title: job.text, company: companyName,
      locationText: job.categories?.location || null,
      salary: job.salaryRange && (job.salaryRange.min != null || job.salaryRange.max != null) ? {
        min: job.salaryRange.min ?? null, max: job.salaryRange.max ?? null,
        currency: job.salaryRange.currency ?? null, period: periods.get(job.salaryRange.interval ?? '') ?? null,
      } : null,
      descriptionText: [
        job.description, ...(job.lists ?? []).flatMap((list) => [list.text, list.content]),
        job.additional ?? '', job.salaryDescription ?? '',
      ].map(htmlToText).filter(Boolean).join('\n'),
      // createdAt exists in the feed but is not documented as publication time.
      postedAt: null,
      applyUrl: job.applyUrl ?? null,
      remoteHint: job.workplaceType == null || job.workplaceType === 'unspecified' ? null : job.workplaceType === 'remote',
      companyAts: { ats: 'lever', slug },
    })));
  },
};
