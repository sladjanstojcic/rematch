import { z } from 'zod';
import type { RawJob } from '../../domain.js';
import { fetchJson } from '../../util/http.js';
import { htmlToText } from '../../util/text.js';
import { createItemIssues, parseEnvelope } from '../itemIssues.js';
import type { AtsAdapter } from '../types.js';

// The Careers Site API returns amounts as decimal strings, including null for unknowns.
const amount = z.union([z.number(), z.string().regex(/^\d+(?:\.\d+)?$/).transform(Number).pipe(z.number())]).nullish();
const publication = z.string()
  .transform((value) => value.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC$/, '$1T$2Z'))
  .pipe(z.iso.datetime({ offset: true })).nullish();

const responseSchema = z.object({ offers: z.array(z.unknown()) });
const itemSchema = z.object({
  id: z.number().int().positive(),
  title: z.string().trim().min(1),
  careers_url: z.url({ protocol: /^https?$/ }),
  careers_apply_url: z.url({ protocol: /^https?$/ }).nullish(),
  description: z.string(),
  requirements: z.string().nullish(),
  location: z.string().nullish(),
  remote: z.boolean().nullish(),
  published_at: publication,
  salary: z.object({ min: amount, max: amount, currency: z.string().nullish(), period: z.string().nullish() }).nullish(),
});

export const recruitee: AtsAdapter = {
  ats: 'recruitee',
  async fetchCompany(slug, companyName, onIssue) {
    const url = `https://${encodeURIComponent(slug)}.recruitee.com/api/offers/`;
    const issues = createItemIssues('recruitee', onIssue);
    const items = parseEnvelope('Recruitee', responseSchema, await fetchJson<unknown>(url)).offers;
    return issues.finish(items.flatMap((item) => issues.parse(itemSchema, item) ?? []).map((job): RawJob => ({
      source: 'recruitee', externalId: String(job.id), url: job.careers_url,
      title: job.title, company: companyName, locationText: job.location || null,
      salary: job.salary && (job.salary.min != null || job.salary.max != null) ? {
        min: job.salary.min ?? null, max: job.salary.max ?? null, currency: job.salary.currency ?? null,
        period: job.salary.period === 'year' || job.salary.period === 'month' || job.salary.period === 'hour' ? job.salary.period : null,
      } : null,
      descriptionText: [job.description, job.requirements ?? ''].map(htmlToText).filter(Boolean).join('\n'),
      postedAt: job.published_at ? new Date(job.published_at) : null,
      applyUrl: job.careers_apply_url ?? null, remoteHint: job.remote ?? null,
      companyAts: { ats: 'recruitee', slug },
    })));
  },
};
