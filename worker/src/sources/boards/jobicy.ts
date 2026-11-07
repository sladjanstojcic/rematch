import { z } from 'zod';
import type { RawJob } from '../../domain.js';
import { fetchJson } from '../../util/http.js';
import { htmlToText } from '../../util/text.js';
import { parseAtsUrl } from '../atsUrl.js';
import type { BoardAdapter } from '../types.js';
import { createItemIssues } from '../itemIssues.js';

const responseSchema = z.object({
  success: z.literal(true).optional(),
  jobs: z.array(z.unknown()),
});
const itemSchema = z.object({
  id: z.number().int().positive(),
  url: z.url({ protocol: /^https$/ }),
  jobTitle: z.string().trim().min(1), companyName: z.string().trim().min(1),
  jobDescription: z.string(), jobGeo: z.string().nullish(),
  pubDate: z.string().pipe(z.coerce.date()).nullish(),
  salaryMin: z.number().nullish(), salaryMax: z.number().nullish(),
  salaryCurrency: z.string().nullish(), salaryPeriod: z.string().nullish(),
});
const periods = new Map<string, NonNullable<RawJob['salary']>['period']>([
  ['yearly', 'year'], ['monthly', 'month'], ['hourly', 'hour'],
]);

export const jobicy: BoardAdapter = {
  name: 'jobicy',
  async fetchJobs(onIssue) {
    // One request per call, including failures. Task 5 owns the durable hourly attempt guard.
    const data = await fetchJson<unknown>('https://jobicy.com/api/jobs?count=100&industry=engineering', { retries: 0 });
    const result = responseSchema.safeParse(data);
    if (!result.success) throw new Error(`Invalid Jobicy response: ${result.error.message}`, { cause: result.error });
    const issues = createItemIssues('jobicy', onIssue);
    const jobs = result.data.jobs.flatMap((raw): RawJob[] => {
      const job = issues.parse(itemSchema, raw);
      if (!job) return [];
      return [{
        source: 'jobicy', externalId: String(job.id), url: job.url,
        title: htmlToText(job.jobTitle), company: htmlToText(job.companyName),
        descriptionText: htmlToText(job.jobDescription), locationText: job.jobGeo || null,
        postedAt: job.pubDate ?? null, applyUrl: null, remoteHint: true,
        salary: job.salaryMin != null || job.salaryMax != null ? {
          min: job.salaryMin ?? null, max: job.salaryMax ?? null,
          currency: job.salaryCurrency ?? null, period: periods.get(job.salaryPeriod ?? '') ?? null,
        } : null,
        companyAts: parseAtsUrl(job.url) ?? undefined,
      }];
    });
    return issues.finish(jobs);
  },
};
