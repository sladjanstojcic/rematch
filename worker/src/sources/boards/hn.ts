import { decodeHTML } from 'entities';
import pLimit from 'p-limit';
import { z } from 'zod';
import type { RawJob } from '../../domain.js';
import { fetchJson, HttpError } from '../../util/http.js';
import { htmlToText } from '../../util/text.js';
import { parseAtsUrl } from '../atsUrl.js';
import type { BoardAdapter } from '../types.js';
import { createItemIssues } from '../itemIssues.js';

const searchUrl = 'https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&query=hiring';
const itemUrl = (id: number) => `https://hacker-news.firebaseio.com/v0/item/${id}.json`;
const searchSchema = z.object({ hits: z.array(z.object({
  objectID: z.string().regex(/^\d+$/), title: z.string(),
})) });
const storySchema = z.object({
  id: z.number().int().positive(), type: z.literal('story'), kids: z.array(z.number().int().positive()).default([]),
});
const itemSchema = z.object({
  id: z.number().int().positive(), type: z.string().optional(),
  deleted: z.boolean().optional(), dead: z.boolean().optional(),
  parent: z.number().int().optional(), text: z.string().optional(), time: z.number().int().nonnegative().optional(),
}).nullable();
const roleWord = /\b(?:engineers?|developers?|designers?|managers?|leads?|architects?|SREs?|scientists?|analysts?)\b/i;

export const hn: BoardAdapter = {
  name: 'hn',
  async fetchJobs(onIssue) {
    const search = searchSchema.safeParse(await fetchJson<unknown>(searchUrl));
    if (!search.success) throw new Error(`Invalid HN search response: ${search.error.message}`, { cause: search.error });
    const hit = search.data.hits.find((story) => story.title.startsWith('Ask HN: Who is hiring?'));
    if (!hit) return [];
    const storyId = Number(hit.objectID);
    const story = storySchema.safeParse(await fetchJson<unknown>(itemUrl(storyId)));
    if (!story.success) throw new Error(`Invalid HN story response: ${story.error.message}`, { cause: story.error });
    if (story.data.id !== storyId) throw new Error('Invalid HN story response: mismatched ID');

    const limit = pLimit(5);
    const issues = createItemIssues('hn', onIssue);
    const jobs = await Promise.all(story.data.kids.map((id) => limit(async (): Promise<RawJob | null> => {
      let data: unknown;
      try {
        data = await fetchJson<unknown>(itemUrl(id));
      } catch (error) {
        issues.skip(`Child ${id}: ${error instanceof HttpError ? `HTTP ${error.status}` : 'request failed'}`);
        return null;
      }
      const comment = issues.parse(itemSchema, data);
      if (!comment || comment.deleted || comment.dead || comment.type !== 'comment'
        || comment.parent !== storyId || !comment.text?.trim()) return null;
      // HN uses opening <p> for paragraph boundaries; isolate the header before shared HTML stripping.
      const header = htmlToText(comment.text.split(/\r?\n|<p\b[^>]*>|<br\b[^>]*>/i)[0]);
      const segments = header.split('|').map((part) => part.trim());
      // No structured company header means a discussion/moderator comment, not an identifiable job.
      if (segments.length < 2 || !segments[0] || !segments.slice(1).some(Boolean)) return null;
      if (comment.time == null) {
        issues.skip('Missing comment time');
        return null;
      }
      const title = segments.slice(1).find((part) => roleWord.test(part)) ?? 'See post';
      const href = /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(comment.text);
      const applyUrl = href ? decodeHTML(href[1] ?? href[2] ?? href[3]) || null : null;
      const url = `https://news.ycombinator.com/item?id=${comment.id}`;
      return {
        source: 'hn', externalId: String(comment.id), url, company: segments[0], title,
        locationText: segments.slice(1).join(' | '), salary: null,
        descriptionText: htmlToText(comment.text), postedAt: new Date(comment.time * 1000),
        applyUrl, remoteHint: null,
        companyAts: parseAtsUrl(applyUrl ?? url) ?? undefined,
      };
    })));
    return issues.finish(jobs.filter((job): job is RawJob => job !== null));
  },
};
