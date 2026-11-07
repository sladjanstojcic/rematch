import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { z } from 'zod';
import type { RawJob } from '../../domain.js';
import { fetchText } from '../../util/http.js';
import { htmlToText } from '../../util/text.js';
import { parseAtsUrl } from '../atsUrl.js';
import type { BoardAdapter } from '../types.js';
import { createItemIssues } from '../itemIssues.js';

const feedUrls = [
  'https://weworkremotely.com/categories/remote-programming-jobs.rss',
  'https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss',
];
const parser = new XMLParser({ parseTagValue: false, isArray: (_name, path) => path === 'rss.channel.item' });
const responseSchema = z.object({ rss: z.object({ channel: z.object({
  item: z.array(z.unknown()).default([]),
}) }) });
const itemSchema = z.object({
  title: z.string().trim().min(1), link: z.url({ protocol: /^https$/ }),
  guid: z.string().min(1).optional(), description: z.string(), region: z.string().nullish(),
  pubDate: z.string().pipe(z.coerce.date()).nullish(),
});

export const wwr: BoardAdapter = {
  name: 'wwr',
  async fetchJobs(onIssue) {
    const jobs = new Map<string, RawJob>();
    const issues = createItemIssues('wwr', onIssue);
    for (const url of feedUrls) {
      const xml = await fetchText(url);
      if (XMLValidator.validate(xml) !== true) throw new Error('Invalid WWR response: malformed XML');
      const result = responseSchema.safeParse(parser.parse(xml));
      if (!result.success) throw new Error(`Invalid WWR response: ${result.error.message}`, { cause: result.error });
      for (const raw of result.data.rss.channel.item) {
        const item = issues.parse(itemSchema, raw);
        if (!item) continue;
        const colon = item.title.indexOf(':');
        const company = htmlToText(item.title.slice(0, colon)).trim();
        const title = htmlToText(item.title.slice(colon + 1)).trim();
        if (colon < 1 || !company || !title) {
          issues.skip('Expected Company: Title');
          continue;
        }
        if (jobs.has(item.link)) continue;
        jobs.set(item.link, {
          source: 'wwr', externalId: item.guid ?? item.link, url: item.link, company, title,
          locationText: item.region || null, salary: null, descriptionText: htmlToText(item.description),
          postedAt: item.pubDate ?? null, applyUrl: null, remoteHint: true,
          companyAts: parseAtsUrl(item.link) ?? undefined,
        });
      }
    }
    return issues.finish([...jobs.values()]);
  },
};
