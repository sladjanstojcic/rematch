import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { jobicy } from '../src/sources/boards/jobicy.js';
import { remoteok } from '../src/sources/boards/remoteok.js';
import { wwr } from '../src/sources/boards/wwr.js';
import { arbeitnow } from '../src/sources/boards/arbeitnow.js';
import { hn } from '../src/sources/boards/hn.js';
import { atsAdapters, boardAdapters } from '../src/sources/registry.js';
import { credit, type BoardAdapter } from '../src/sources/types.js';
import { HttpError } from '../src/util/http.js';

// Real selected records are unchanged. All mutations and inline payloads below are synthetic.
const json = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const xml = (name: string) => readFileSync(new URL(`./fixtures/${name}.xml`, import.meta.url), 'utf8');
const jobicyFixture = json('jobicy');
const remoteokFixture = json('remoteok');
const arbeitnowFixture = json('arbeitnow');
const hnSearch = json('hn-story-search');
const hnFixture = json('hn-comments');
const jobicyUrl = 'https://jobicy.com/api/jobs?count=100&industry=engineering';
const remoteokUrl = 'https://remoteok.com/api';
const wwrUrls = ['https://weworkremotely.com/categories/remote-programming-jobs.rss', 'https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss'];
const arbeitnowUrls = [1, 2, 3].map((page) => `https://www.arbeitnow.com/api/job-board-api?page=${page}`);
const hnSearchUrl = 'https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&query=hiring';
const itemUrl = (id: number) => `https://hacker-news.firebaseio.com/v0/item/${id}.json`;
const storyId = 50338728;

function serve(routes: Record<string, unknown>) {
  const mock = vi.fn(async (url: string, _init?: RequestInit) => {
    if (!(url in routes)) return new Response('Unexpected test URL', { status: 400 });
    const value = routes[url];
    return value instanceof Response ? value : typeof value === 'string' ? new Response(value) : Response.json(value);
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

// Route only the selected captured kids. Production must follow every ID it receives.
function hnRoutes(comments = hnFixture.comments, story = { ...hnFixture.story, kids: comments.map((c: { id: number }) => c.id) }) {
  return {
    [hnSearchUrl]: hnSearch, [itemUrl(storyId)]: story,
    ...Object.fromEntries(comments.map((comment: { id: number }) => [itemUrl(comment.id), comment])),
  };
}
const cases: { adapter: BoardAdapter; routes: Record<string, unknown>; count: number }[] = [
  { adapter: jobicy, routes: { [jobicyUrl]: jobicyFixture }, count: 5 },
  { adapter: remoteok, routes: { [remoteokUrl]: remoteokFixture.response }, count: 4 },
  { adapter: wwr, routes: { [wwrUrls[0]]: xml('wwr-programming'), [wwrUrls[1]]: xml('wwr-full-stack') }, count: 10 },
  { adapter: arbeitnow, routes: Object.fromEntries(arbeitnowUrls.map((url, i) => [url, arbeitnowFixture.pages[i]])), count: 4 },
  { adapter: hn, routes: hnRoutes(), count: 6 },
];

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe.each(cases)('$adapter.name real captures', ({ adapter, routes, count }) => {
  it('normalizes the filtered listings and keeps board identity, URLs and global UA', async () => {
    const mock = serve(routes);
    const jobs = await adapter.fetchJobs();
    expect(jobs).toHaveLength(count);
    for (const job of jobs) {
      expect(job.source).toBe(adapter.name);
      expect(job.externalId).toMatch(/\S/);
      expect(job.title).toMatch(/\S/);
      expect(job.company).toMatch(/\S/);
      expect(job.url).toMatch(/^https:\/\//);
      expect(job.descriptionText).toMatch(/\S/);
      expect(job.postedAt).toBeInstanceOf(Date);
      expect(Number.isFinite(job.postedAt?.getTime())).toBe(true);
      expect(credit[job.source].url).toMatch(/^https:\/\//);
    }
    expect(mock.mock.calls.map(([url]) => url).sort()).toEqual(Object.keys(routes).sort());
    for (const [, init] of mock.mock.calls) {
      expect(new Headers(init?.headers).get('User-Agent')).toBe('RematchBot/0.1 (+https://github.com/rematch-app)');
    }
  });

  it('rejects a changed response shape with source context instead of reporting zero jobs', async () => {
    serve(Object.fromEntries(Object.keys(routes).map((url) => [url, adapter.name === 'wwr' ? '<html>Unavailable</html>' : {}])));
    await expect(adapter.fetchJobs()).rejects.toThrow(new RegExp(`${adapter.name === 'wwr' ? 'WWR' : adapter.name}.*response`, 'i'));
  });

  it('propagates a source failure for the collector to record', async () => {
    serve(Object.fromEntries(Object.keys(routes).map((url) => [url, new Response('Forbidden', { status: 403 })])));
    await expect(adapter.fetchJobs()).rejects.toBeInstanceOf(HttpError);
  });
});

it('registers all five boards once and exposes the four existing ATS adapters', () => {
  expect(boardAdapters.map((adapter) => adapter.name).sort()).toEqual(['arbeitnow', 'hn', 'jobicy', 'remoteok', 'wwr']);
  expect(Object.keys(atsAdapters).sort()).toEqual(['ashby', 'greenhouse', 'lever', 'recruitee']);
  for (const [name, adapter] of Object.entries(atsAdapters)) {
    expect(adapter.ats).toBe(name);
    expect(adapter.fetchCompany).toBeTypeOf('function');
  }
  expect(credit.remoteok).toEqual({ name: 'Remote OK', url: 'https://remoteok.com' });
});

describe('Jobicy', () => {
  it('maps publication, location and supplied salary without replacing the board link', async () => {
    serve({ [jobicyUrl]: jobicyFixture });
    const jobs = await jobicy.fetchJobs();
    expect(jobs[0]).toMatchObject({ externalId: '159172', company: 'Canonical', title: 'Salesforce Administrator', locationText: 'EMEA', salary: null, applyUrl: null, remoteHint: true, postedAt: new Date('2026-11-05T14:05:23Z'), url: 'https://jobicy.com/jobs/159172-salesforce-administrator' });
    expect(jobs[2].salary).toEqual({ min: 182000, max: 250208, currency: 'USD', period: 'year' });
    expect(jobs[0].descriptionText).not.toMatch(/<\/?p>|&amp;/);
  });
  it('does not automatically retry even a transient failure within the hourly window', async () => {
    const mock = serve({ [jobicyUrl]: new Response('Unavailable', { status: 503 }) });
    await expect(jobicy.fetchJobs()).rejects.toMatchObject({ status: 503 });
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it('accepts a successful empty feed, but rejects an API error envelope', async () => {
    serve({ [jobicyUrl]: { jobs: [], success: true } });
    expect(await jobicy.fetchJobs()).toEqual([]);
    serve({ [jobicyUrl]: { jobs: [], success: false, error: 'bad filter' } });
    await expect(jobicy.fetchJobs()).rejects.toThrow(/Jobicy.*response/);
  });
});

describe('RemoteOK', () => {
  it('drops element zero even if it looks like a job and uses exact allowed tags', async () => {
    const base = remoteokFixture.response[1];
    const tags = ['dev', 'engineer', 'developer', 'frontend', 'backend', 'fullstack', 'development', 'engineering'];
    serve({ [remoteokUrl]: [base, ...tags.map((tag, i) => ({ ...base, id: String(i + 1), tags: [tag] }))] });
    expect((await remoteok.fetchJobs()).map((j) => j.externalId)).toEqual(['1', '2', '3', '4', '5', '6']);
  });
  it('discovers an ATS from apply_url without changing the original board URL or credit', async () => {
    const base = remoteokFixture.response[1];
    serve({ [remoteokUrl]: [{ legal: 'Synthetic legal notice' }, { ...base, apply_url: 'https://jobs.lever.co/acme/1' }] });
    const [job] = await remoteok.fetchJobs();
    expect(job).toMatchObject({ source: 'remoteok', externalId: '1137685', url: 'https://remoteOK.com/remote-jobs/remote-software-engineer-claims-1137685', applyUrl: 'https://jobs.lever.co/acme/1', companyAts: { ats: 'lever', slug: 'acme' }, postedAt: new Date('2026-11-04T15:09:09Z') });
  });
  it('treats absent salary currency and period as unknown and zero-only bounds as unavailable', async () => {
    serve({ [remoteokUrl]: remoteokFixture.response });
    const jobs = await remoteok.fetchJobs();
    expect(jobs[0].salary).toEqual({ min: 10000, max: 30000, currency: null, period: null });
    expect(jobs.find((job) => job.externalId === '1137674')?.salary).toEqual({ min: 75000, max: 75000, currency: null, period: null });
    expect(jobs.find((job) => job.externalId === '1137624')?.salary).toBeNull();
  });
  it('accepts a legal-notice-only feed', async () => {
    serve({ [remoteokUrl]: [remoteokFixture.response[0]] });
    expect(await remoteok.fetchJobs()).toEqual([]);
  });
});

const rss = (items: string) => `<rss version="2.0"><channel><title>Synthetic feed</title>${items}</channel></rss>`;
const rssItem = (title: string, link = 'https://weworkremotely.com/remote-jobs/acme-dev') => `<item><title>${title}</title><link>${link}</link><region>Europe</region><description><![CDATA[<p>Build &amp; test &lt;T&gt;</p>]]></description><pubDate>Thu, 05 Nov 2026 12:00:00 +0000</pubDate></item>`;
describe('WWR', () => {
  it('splits the first colon, reads region, handles a single item and deduplicates overlapping categories', async () => {
    const item = rssItem('Acme: Senior Dev');
    serve({ [wwrUrls[0]]: rss(item), [wwrUrls[1]]: rss(item + rssItem('Acme: Senior Dev: Platform', 'https://weworkremotely.com/remote-jobs/acme-platform')) });
    const jobs = await wwr.fetchJobs();
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({ company: 'Acme', title: 'Senior Dev', locationText: 'Europe', descriptionText: 'Build & test <T>', applyUrl: null, remoteHint: true, postedAt: new Date('2026-11-05T12:00:00Z') });
    expect(jobs[1].title).toBe('Senior Dev: Platform');
  });
  it('skips an unsplittable title and keeps the good item without inventing a company', async () => {
    const onIssue = vi.fn();
    serve({ [wwrUrls[0]]: rss(rssItem('Senior Developer')), [wwrUrls[1]]: rss(rssItem('Acme: Senior Dev')) });
    expect(await wwr.fetchJobs(onIssue)).toEqual([expect.objectContaining({ company: 'Acme', title: 'Senior Dev' })]);
    expect(onIssue).toHaveBeenCalledExactlyOnceWith({ source: 'wwr', skipped: 1, message: expect.stringContaining('Company: Title') });
  });
  it('accepts empty channels and rejects malformed XML', async () => {
    serve(Object.fromEntries(wwrUrls.map((url) => [url, rss('')])));
    expect(await wwr.fetchJobs()).toEqual([]);
    serve(Object.fromEntries(wwrUrls.map((url) => [url, '<rss><channel>'])));
    await expect(wwr.fetchJobs()).rejects.toThrow(/WWR.*response/);
  });
});

describe('Arbeitnow', () => {
  it('fetches pages 1-3 only, uses strict remote flags and maps Unix seconds', async () => {
    const base = arbeitnowFixture.pages[0].data[1];
    const mock = serve(Object.fromEntries(arbeitnowUrls.map((url, i) => [url, { data: [{ ...base, slug: `synthetic-${i}`, remote: i === 1 }], links: { next: 'https://example.test/do-not-follow' } }])));
    const jobs = await arbeitnow.fetchJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ externalId: 'synthetic-1', remoteHint: true, applyUrl: null, salary: null, postedAt: new Date(base.created_at * 1000), url: base.url });
    expect(mock.mock.calls.map(([url]) => url)).toEqual(arbeitnowUrls);
  });
  it('decodes the observed escaped HTML layer while retaining literal encoded angle brackets in ordinary HTML', async () => {
    const base = arbeitnowFixture.pages[0].data[2];
    expect(base.description).toMatch(/^&lt;div/);
    serve({ [arbeitnowUrls[0]]: { data: [base, { ...base, slug: 'synthetic-literal', description: '<p>Use &lt;T&gt; &amp; compare</p>' }] }, [arbeitnowUrls[1]]: { data: [] }, [arbeitnowUrls[2]]: { data: [] } });
    const jobs = await arbeitnow.fetchJobs();
    expect(jobs[0].descriptionText).toContain('From Fivetran');
    expect(jobs[0].descriptionText).not.toMatch(/&lt;|<\/?(?:div|p)\b/);
    expect(jobs[1].descriptionText).toBe('Use <T> & compare');
  });
});

describe('HN', () => {
  const comment = (id: number, text = 'Acme | Senior Engineer | REMOTE<p>Build <a href="https:&#x2F;&#x2F;jobs.lever.co&#x2F;acme&#x2F;1?x=1&amp;y=2">Apply</a>', extra = {}) => ({ id, type: 'comment', parent: storyId, time: 1793894400, text, ...extra });
  it('maps Firebase fields, extracts the real first header and decodes the first href once', async () => {
    const comments = [comment(1), comment(2, 'Acme | REMOTE | Full time<p>We need an Engineer'), comment(3, 'Acme | Designer\nBody')];
    serve(hnRoutes(comments));
    const jobs = await hn.fetchJobs();
    expect(jobs[0]).toMatchObject({ externalId: '1', source: 'hn', company: 'Acme', title: 'Senior Engineer', url: 'https://news.ycombinator.com/item?id=1', postedAt: new Date('2026-11-05T16:00:00Z'), applyUrl: 'https://jobs.lever.co/acme/1?x=1&y=2', companyAts: { ats: 'lever', slug: 'acme' } });
    expect(jobs[0].descriptionText).toContain('Build Apply');
    expect(jobs[1].title).toBe('See post');
    expect(jobs[2].title).toBe('Designer');
  });
  it('skips replies, deleted/dead/null items and non-job comments without fabricating a company', async () => {
    const comments = [comment(1), comment(2, 'Reply | Engineer', { parent: 1 }), { id: 3, deleted: true }, { id: 4, dead: true }, comment(5, 'Thanks for posting!'), comment(6, ' | Engineer | REMOTE'), comment(7, '', { text: undefined })];
    const routes = hnRoutes(comments, { ...hnFixture.story, kids: [1, 2, 3, 4, 5, 6, 7, 8] });
    serve({ ...routes, [itemUrl(8)]: null });
    expect((await hn.fetchJobs()).map((job) => job.externalId)).toEqual(['1']);
  });
  it('uses the first matching story and fetches all its top-level kids without following replies', async () => {
    // More than a common search page size; each comment has replies that must not consume a cap.
    const comments = Array.from({ length: 45 }, (_, i) => comment(i + 1, 'Acme | Developer | REMOTE', { kids: [1000 + i] }));
    const mock = serve({ ...hnRoutes(comments), [hnSearchUrl]: { hits: [{ objectID: '99', title: 'Ask HN: Who wants to be hired?' }, { objectID: String(storyId), title: 'Ask HN: Who is hiring? (November 2026)' }, { objectID: '98', title: 'Ask HN: Who is hiring? (October 2026)' }] } });
    const jobs = await hn.fetchJobs();
    expect(jobs).toHaveLength(45);
    expect(new Set(jobs.map((j) => j.title))).toEqual(new Set(['Developer']));
    expect(mock.mock.calls).toHaveLength(47);
    expect(mock.mock.calls.map(([url]) => url)).not.toContain(itemUrl(1000));
  });
  it('accepts no matching story or an empty story, but rejects a missing selected story', async () => {
    serve({ [hnSearchUrl]: { hits: [] } });
    expect(await hn.fetchJobs()).toEqual([]);
    serve(hnRoutes([], { ...hnFixture.story, kids: undefined }));
    expect(await hn.fetchJobs()).toEqual([]);
    serve({ [hnSearchUrl]: hnSearch, [itemUrl(storyId)]: null });
    await expect(hn.fetchJobs()).rejects.toThrow(/HN.*response/);
  });
});

// Fix I1 regressions: all payload mutations here are synthetic, never additional live captures.
const goodJobicy = jobicyFixture.jobs[0];
const goodRemoteok = remoteokFixture.response[1];
const goodArbeitnow = arbeitnowFixture.pages[0].data[1];
const goodComment = hnFixture.comments[0];
const badComment = { ...hnFixture.comments[1], time: 'not-a-time' };
const pageRoutes = (data: unknown[][]) => Object.fromEntries(arbeitnowUrls.map((url, i) => [url, { data: data[i] }]));
const robustnessCases: {
  adapter: BoardAdapter; mixed: Record<string, unknown>; invalid: Record<string, unknown>;
  empty: Record<string, unknown>; id: string; skipped: number;
}[] = [
  {
    adapter: jobicy, id: '159172', skipped: 3,
    mixed: { [jobicyUrl]: { jobs: [goodJobicy, { ...goodJobicy, companyName: '' }, { ...goodJobicy, url: 'http://jobicy.com/bad' }, { ...goodJobicy, pubDate: 'invalid' }] } },
    invalid: { [jobicyUrl]: { jobs: [{ ...goodJobicy, companyName: '' }] } },
    empty: { [jobicyUrl]: { jobs: [] } },
  },
  {
    adapter: remoteok, id: '1137685', skipped: 1,
    mixed: { [remoteokUrl]: [remoteokFixture.response[0], goodRemoteok, { ...goodRemoteok, apply_url: 'mailto:jobs@example.test' }, { tags: ['sales'], company: '' }] },
    invalid: { [remoteokUrl]: [remoteokFixture.response[0], { ...goodRemoteok, apply_url: 'mailto:jobs@example.test' }, { ...goodRemoteok, tags: ['sales'] }] },
    empty: { [remoteokUrl]: [remoteokFixture.response[0], { ...goodRemoteok, tags: ['sales'] }] },
  },
  {
    adapter: arbeitnow, id: goodArbeitnow.slug, skipped: 2,
    mixed: pageRoutes([[goodArbeitnow], [{ ...goodArbeitnow, title: '' }], [{ ...goodArbeitnow, url: 'http://www.arbeitnow.com/bad' }, { remote: false }]]),
    invalid: pageRoutes([[], [{ ...goodArbeitnow, title: '' }], [{ ...goodArbeitnow, remote: false }]]),
    empty: pageRoutes([[], [{ ...goodArbeitnow, remote: false }], []]),
  },
  {
    adapter: wwr, id: 'https://weworkremotely.com/remote-jobs/acme-dev', skipped: 2,
    mixed: { [wwrUrls[0]]: rss(rssItem('Acme: Senior Dev')), [wwrUrls[1]]: rss(rssItem('No company separator') + rssItem('Acme: Dev', 'http://weworkremotely.com/bad')) },
    invalid: { [wwrUrls[0]]: rss(rssItem('No company separator')), [wwrUrls[1]]: rss('') },
    empty: { [wwrUrls[0]]: rss(''), [wwrUrls[1]]: rss('') },
  },
  {
    adapter: hn, id: String(goodComment.id), skipped: 2,
    mixed: hnRoutes([goodComment, badComment, { ...hnFixture.comments[2], time: undefined }]),
    invalid: hnRoutes([badComment, { id: 3, deleted: true }]),
    empty: hnRoutes([{ id: 3, deleted: true }, { id: 4, dead: true }, { ...goodComment, text: 'Thanks for posting!' }, { ...goodComment, id: 5, parent: 1 }]),
  },
];

describe.each(robustnessCases)('$adapter.name item isolation', ({ adapter, mixed, invalid, empty, id, skipped }) => {
  it('keeps healthy jobs and emits one bounded diagnostic for invalid processable items', async () => {
    serve(mixed);
    const onIssue = vi.fn();
    const jobs = await adapter.fetchJobs(onIssue);
    expect(jobs.map((job) => job.externalId)).toEqual([id]);
    expect(onIssue).toHaveBeenCalledExactlyOnceWith({ source: adapter.name, skipped, message: expect.any(String) });
    expect(onIssue.mock.calls[0][0].message.length).toBeGreaterThan(0);
    expect(onIssue.mock.calls[0][0].message.length).toBeLessThanOrEqual(600);
  });

  it('preserves the no-callback API while isolating invalid records', async () => {
    serve(mixed);
    expect((await adapter.fetchJobs()).map((job) => job.externalId)).toEqual([id]);
  });

  it('rejects all-invalid processable records even alongside legitimate filtered/deleted items', async () => {
    serve(invalid);
    const onIssue = vi.fn();
    await expect(adapter.fetchJobs(onIssue)).rejects.toThrow(/all.*invalid/i);
    expect(onIssue).toHaveBeenCalledExactlyOnceWith({ source: adapter.name, skipped: 1, message: expect.any(String) });
  });

  it('accepts legitimate empty or filter-only/deleted results without an issue', async () => {
    serve(empty);
    const onIssue = vi.fn();
    expect(await adapter.fetchJobs(onIssue)).toEqual([]);
    expect(onIssue).not.toHaveBeenCalled();
  });
});

it('does not discard one healthy job because many other items are invalid, and bounds diagnostic payloads', async () => {
  const bad = Array.from({ length: 120 }, (_, i) => ({ ...goodJobicy, companyName: '', url: `http://example.test/${i}/${'private-content-'.repeat(1000)}` }));
  serve({ [jobicyUrl]: { jobs: [goodJobicy, ...bad] } });
  const onIssue = vi.fn();
  expect((await jobicy.fetchJobs(onIssue)).map((job) => job.externalId)).toEqual(['159172']);
  expect(onIssue).toHaveBeenCalledExactlyOnceWith({ source: 'jobicy', skipped: 120, message: expect.any(String) });
  expect(onIssue.mock.calls[0][0].message.length).toBeLessThanOrEqual(600);
  expect(onIssue.mock.calls[0][0].message).not.toContain('private-content-');
});

it('does not retain item diagnostics between fetchJobs calls', async () => {
  const onIssue = vi.fn();
  serve({ [jobicyUrl]: { jobs: [goodJobicy, { ...goodJobicy, companyName: '' }] } });
  expect(await jobicy.fetchJobs(onIssue)).toHaveLength(1);
  serve({ [jobicyUrl]: { jobs: [goodJobicy] } });
  expect(await jobicy.fetchJobs(onIssue)).toHaveLength(1);
  expect(onIssue).toHaveBeenCalledTimes(1);
});

it('keeps valid HN children after another child exhausts HTTP retries, and continues later children', async () => {
  vi.useFakeTimers();
  const failedId = badComment.id;
  const later = hnFixture.comments[2];
  const mock = serve({ ...hnRoutes([goodComment, badComment, later]), [itemUrl(failedId)]: new Response('Unavailable', { status: 503 }) });
  const onIssue = vi.fn();
  const result = hn.fetchJobs(onIssue).then((jobs) => jobs.map((job) => job.externalId), (error: unknown) => error);
  await vi.runAllTimersAsync();
  expect(await result).toEqual([String(goodComment.id), String(later.id)]);
  expect(mock.mock.calls.filter(([url]) => url === itemUrl(failedId))).toHaveLength(3);
  expect(onIssue).toHaveBeenCalledExactlyOnceWith({ source: 'hn', skipped: 1, message: expect.stringContaining('503') });
});

it('rejects HN when all child requests fail, with an aggregate diagnostic', async () => {
  const onIssue = vi.fn();
  serve({ ...hnRoutes([goodComment]), [itemUrl(goodComment.id)]: new Response('Forbidden', { status: 403 }) });
  await expect(hn.fetchJobs(onIssue)).rejects.toThrow(/all.*invalid/i);
  expect(onIssue).toHaveBeenCalledExactlyOnceWith({ source: 'hn', skipped: 1, message: expect.stringContaining('403') });
});

it.each([
  { adapter: arbeitnow, routes: { ...pageRoutes([[goodArbeitnow], [], []]), [arbeitnowUrls[1]]: { data: 'changed' } } },
  { adapter: wwr, routes: { [wwrUrls[0]]: rss(rssItem('Acme: Dev')), [wwrUrls[1]]: '<html>Changed</html>' } },
])('$adapter.name still rejects a malformed later envelope after healthy earlier records', async ({ adapter, routes }) => {
  serve(routes);
  await expect(adapter.fetchJobs()).rejects.toThrow(/response/i);
});
