import { decodeHTML } from 'entities';
import { z } from 'zod';
import type { RawJob } from '../../domain.js';
import { fetchJson } from '../../util/http.js';
import { htmlToText } from '../../util/text.js';
import { createItemIssues, parseEnvelope } from '../itemIssues.js';
import type { AtsAdapter } from '../types.js';

const responseSchema = z.object({ jobs: z.array(z.unknown()) });
const itemSchema = z.object({
  id: z.number().int().positive(),
  title: z.string().trim().min(1),
  absolute_url: z.url({ protocol: /^https?$/ }),
  content: z.string(),
  location: z.object({ name: z.string().nullish() }).nullish(),
  first_published: z.iso.datetime({ offset: true }).nullish(),
});

export const greenhouse: AtsAdapter = {
  ats: 'greenhouse',
  async fetchCompany(slug, companyName, onIssue) {
    const url = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug)}/jobs?content=true`;
    const issues = createItemIssues('greenhouse', onIssue);
    const items = parseEnvelope('Greenhouse', responseSchema, await fetchJson<unknown>(url)).jobs;
    return issues.finish(items.flatMap((item) => issues.parse(itemSchema, item) ?? []).map((job): RawJob => ({
      source: 'greenhouse', externalId: String(job.id), url: job.absolute_url,
      title: job.title, company: companyName, locationText: job.location?.name || null,
      salary: null,
      // Greenhouse escapes the HTML itself (real fixture jobs[0].content).
      // Remove exactly that provider layer; htmlToText preserves literal encoded text.
      descriptionText: htmlToText(decodeHTML(job.content)),
      postedAt: job.first_published ? new Date(job.first_published) : null,
      applyUrl: job.absolute_url, remoteHint: null, companyAts: { ats: 'greenhouse', slug },
    })));
  },
};
