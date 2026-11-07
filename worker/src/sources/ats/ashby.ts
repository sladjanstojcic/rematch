import { z } from 'zod';
import type { RawJob } from '../../domain.js';
import { fetchJson } from '../../util/http.js';
import { htmlToText } from '../../util/text.js';
import { createItemIssues, parseEnvelope } from '../itemIssues.js';
import type { AtsAdapter } from '../types.js';

const responseSchema = z.object({ jobs: z.array(z.unknown()) });
const listedSchema = z.object({ isListed: z.boolean().optional() });
const itemSchema = z.object({
  id: z.string().min(1),
  title: z.string().trim().min(1),
  jobUrl: z.url({ protocol: /^https?$/ }),
  applyUrl: z.url({ protocol: /^https?$/ }).nullish(),
  descriptionHtml: z.string(),
  location: z.string().nullish(),
  isRemote: z.boolean().nullish(),
  isListed: z.boolean().optional(),
  publishedAt: z.iso.datetime({ offset: true }).nullish(),
  compensation: z.object({
    summaryComponents: z.array(z.object({
      compensationType: z.string(),
      minValue: z.number().nullish(),
      maxValue: z.number().nullish(),
      currencyCode: z.string().nullish(),
      interval: z.string().nullish(),
    })),
  }).nullish(),
});

const periods = new Map<string, NonNullable<RawJob['salary']>['period']>([
  ['1 YEAR', 'year'], ['1 MONTH', 'month'], ['1 HOUR', 'hour'],
]);

export const ashby: AtsAdapter = {
  ats: 'ashby',
  async fetchCompany(slug, companyName, onIssue) {
    const url = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug)}?includeCompensation=true`;
    const issues = createItemIssues('ashby', onIssue);
    const items = parseEnvelope('Ashby', responseSchema, await fetchJson<unknown>(url)).jobs;
    // Unlisted jobs are omitted before validation, so they never count as invalid.
    const listed = items.filter((item) => listedSchema.safeParse(item).data?.isListed !== false);
    return issues.finish(listed.flatMap((item) => issues.parse(itemSchema, item) ?? []).map((job): RawJob => {
      const salary = job.compensation?.summaryComponents.find((component) => component.compensationType === 'Salary');
      return {
        source: 'ashby', externalId: job.id, url: job.jobUrl, title: job.title, company: companyName,
        locationText: job.location || null,
        salary: salary && (salary.minValue != null || salary.maxValue != null) ? {
          min: salary.minValue ?? null, max: salary.maxValue ?? null,
          currency: salary.currencyCode ?? null, period: periods.get(salary.interval ?? '') ?? null,
        } : null,
        descriptionText: htmlToText(job.descriptionHtml),
        postedAt: job.publishedAt ? new Date(job.publishedAt) : null,
        applyUrl: job.applyUrl ?? null, remoteHint: job.isRemote ?? null,
        companyAts: { ats: 'ashby', slug },
      };
    }));
  },
};
