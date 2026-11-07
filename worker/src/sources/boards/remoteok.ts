import { z } from 'zod';
import type { RawJob } from '../../domain.js';
import { fetchJson } from '../../util/http.js';
import { htmlToText } from '../../util/text.js';
import { parseAtsUrl } from '../atsUrl.js';
import type { BoardAdapter } from '../types.js';
import { createItemIssues } from '../itemIssues.js';

const itemSchema = z.object({
  id: z.string().min(1), position: z.string().trim().min(1), company: z.string().trim().min(1),
  url: z.url({ protocol: /^https$/ }),
  apply_url: z.union([z.url({ protocol: /^https?$/ }), z.literal('')]).nullish(),
  tags: z.array(z.string()), description: z.string(), location: z.string().nullish(),
  date: z.string().pipe(z.coerce.date()).nullish(),
  salary_min: z.number().nullish(), salary_max: z.number().nullish(),
});
const tagsSchema = itemSchema.pick({ tags: true });
const allowedTags = new Set(['dev', 'engineer', 'developer', 'frontend', 'backend', 'fullstack']);

export const remoteok: BoardAdapter = {
  name: 'remoteok',
  async fetchJobs(onIssue) {
    const data = await fetchJson<unknown>('https://remoteok.com/api');
    if (!Array.isArray(data)) throw new Error('Invalid RemoteOK response: expected an array');
    // Element zero is the API legal notice, never a listing.
    const issues = createItemIssues('remoteok', onIssue);
    const jobs = data.slice(1).flatMap((raw): RawJob[] => {
      const filter = issues.parse(tagsSchema, raw);
      if (!filter || !filter.tags.some((tag) => allowedTags.has(tag))) return [];
      const job = issues.parse(itemSchema, raw);
      if (!job) return [];
      const applyUrl = job.apply_url || null;
      // The feed uses zero for unavailable bounds and supplies no currency/period fields.
      const min = job.salary_min && job.salary_min > 0 ? job.salary_min : null;
      const max = job.salary_max && job.salary_max > 0 ? job.salary_max : null;
      return [{
        source: 'remoteok', externalId: job.id, url: job.url,
        title: htmlToText(job.position), company: htmlToText(job.company),
        locationText: job.location || null, descriptionText: htmlToText(job.description),
        postedAt: job.date ?? null, applyUrl, remoteHint: true,
        salary: min != null || max != null ? { min, max, currency: null, period: null } : null,
        companyAts: parseAtsUrl(applyUrl ?? job.url) ?? undefined,
      }];
    });
    return issues.finish(jobs);
  },
};
