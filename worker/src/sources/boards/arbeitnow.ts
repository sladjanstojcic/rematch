import { decodeHTML } from 'entities';
import { z } from 'zod';
import type { RawJob } from '../../domain.js';
import { fetchJson } from '../../util/http.js';
import { htmlToText } from '../../util/text.js';
import { parseAtsUrl } from '../atsUrl.js';
import type { BoardAdapter } from '../types.js';
import { createItemIssues } from '../itemIssues.js';

const responseSchema = z.object({ data: z.array(z.unknown()) });
const itemSchema = z.object({
  slug: z.string().min(1), title: z.string().trim().min(1), company_name: z.string().trim().min(1),
  url: z.url({ protocol: /^https$/ }), remote: z.boolean(), description: z.string(),
  location: z.string().nullish(), created_at: z.number().int().nonnegative().nullish(),
});
const remoteSchema = itemSchema.pick({ remote: true });

export const arbeitnow: BoardAdapter = {
  name: 'arbeitnow',
  async fetchJobs(onIssue) {
    const jobs: RawJob[] = [];
    const issues = createItemIssues('arbeitnow', onIssue);
    for (let page = 1; page <= 3; page++) {
      const data = await fetchJson<unknown>(`https://www.arbeitnow.com/api/job-board-api?page=${page}`);
      const result = responseSchema.safeParse(data);
      if (!result.success) throw new Error(`Invalid Arbeitnow response: ${result.error.message}`, { cause: result.error });
      for (const raw of result.data.data) {
        const filter = issues.parse(remoteSchema, raw);
        if (!filter || filter.remote !== true) continue;
        const job = issues.parse(itemSchema, raw);
        if (!job) continue;
        // Real upstream ATS descriptions mix ordinary HTML with one escaped structural layer.
        const description = /^\s*&lt;(?:div|p|h[1-6]|ul|ol|section)\b/i.test(job.description)
          ? decodeHTML(job.description) : job.description;
        jobs.push({
          source: 'arbeitnow', externalId: job.slug, url: job.url,
          title: htmlToText(job.title), company: htmlToText(job.company_name),
          locationText: job.location || null, salary: null, descriptionText: htmlToText(description),
          postedAt: job.created_at == null ? null : new Date(job.created_at * 1000),
          applyUrl: null, remoteHint: true, companyAts: parseAtsUrl(job.url) ?? undefined,
        });
      }
    }
    return issues.finish(jobs);
  },
};
