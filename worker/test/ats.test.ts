import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ashby } from '../src/sources/ats/ashby.js';
import { greenhouse } from '../src/sources/ats/greenhouse.js';
import { lever } from '../src/sources/ats/lever.js';
import { recruitee } from '../src/sources/ats/recruitee.js';
import { credit, type AtsAdapter, type BoardAdapter } from '../src/sources/types.js';
import { HttpError } from '../src/util/http.js';

// Real captures are immutable inputs. All mutations below are synthetic edge cases.
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const ashbyFixture = fixture('ashby');
const greenhouseFixture = fixture('greenhouse');
const leverFixture = fixture('lever');
const recruiteeFixture = fixture('recruitee');
const cases = [
  { adapter: ashby, slug: 'ashby', data: ashbyFixture, url: ashbyFixture._source, list: 'jobs', title: 'title' },
  { adapter: greenhouse, slug: 'greenhouse', data: greenhouseFixture, url: greenhouseFixture._source, list: 'jobs', title: 'title' },
  // Lever returns a native array; only the saved fixture has a metadata envelope.
  { adapter: lever, slug: 'palantir', data: leverFixture.jobs, url: leverFixture._source, list: null, title: 'text' },
  { adapter: recruitee, slug: 'jobs', data: recruiteeFixture, url: recruiteeFixture._source, list: 'offers', title: 'title' },
] as const;

function serve(data: unknown, expectedUrl?: string) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (expectedUrl) expect(url).toBe(expectedUrl);
    expect(new Headers(init?.headers).get('User-Agent')).toBe('RematchBot/0.1 (+https://github.com/rematch-app)');
    return Response.json(data);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe.each(cases)('$adapter.ats real fixture', ({ adapter, slug, data, url, list, title }) => {
  it('normalizes all three jobs and preserves ATS identity and source URLs', async () => {
    const fetchMock = serve(data, url);
    const jobs = await adapter.fetchCompany(slug, 'Provided Company Name');
    expect(jobs).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const job of jobs) {
      expect(job.source).toBe(adapter.ats);
      expect(job.externalId).toEqual(expect.stringMatching(/\S/));
      expect(job.url).toMatch(/^https:\/\//);
      expect(job.applyUrl).toMatch(/^https:\/\//);
      expect(job.title).toEqual(expect.stringMatching(/\S/));
      expect(job.company).toBe('Provided Company Name');
      expect(job.descriptionText).toEqual(expect.stringMatching(/\S/));
      expect(job.descriptionText).not.toMatch(/<\/?[a-z][^>]*>/i);
      expect(job.companyAts).toEqual({ ats: adapter.ats, slug });
    }
  });

  it('accepts HTTP job and apply links without losing the rest of the company', async () => {
    const mixed = structuredClone(data);
    const row = (list ? mixed[list] : mixed)[1];
    const fields = { ashby: ['jobUrl', 'applyUrl'], greenhouse: ['absolute_url'],
      lever: ['hostedUrl', 'applyUrl'], recruitee: ['careers_url', 'careers_apply_url'] }[adapter.ats];
    for (const field of fields) row[field] = row[field].replace('https:', 'http:');
    serve(mixed);
    const jobs = await adapter.fetchCompany(slug, 'Company');
    expect(jobs).toHaveLength(3);
    expect(jobs[1].url).toMatch(/^http:\/\//);
    expect(jobs[1].applyUrl).toMatch(/^http:\/\//);
    expect(jobs[0].url).toMatch(/^https:\/\//);
  });

  it('reports a top-level shape change as one short path and code, not a Zod dump', async () => {
    serve(list ? { [list]: 'changed' } : { changed: true });
    const error = await adapter.fetchCompany(slug, 'Company').catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/response: \w*\.?invalid_type$/);
    expect((error as Error).message.length).toBeLessThan(120);
    expect((error as Error).message).not.toContain('[');
  });

  it('accepts an empty board', async () => {
    serve(list ? { [list]: [] } : []);
    expect(await adapter.fetchCompany(slug, 'Company')).toEqual([]);
  });

  it.each([null, {}, { jobs: 'changed', offers: 'changed' }])('rejects malformed top-level response %j with source context', async (bad) => {
    serve(bad);
    await expect(adapter.fetchCompany(slug, 'Company')).rejects.toThrow(new RegExp(`${adapter.ats}.*response`, 'i'));
  });

  it('skips and reports one malformed job while keeping the rest of the company', async () => {
    const bad = structuredClone(data);
    (list ? bad[list] : bad)[1][title] = 42;
    serve(bad);
    const issues: unknown[] = [];
    const jobs = await adapter.fetchCompany(slug, 'Company', (issue) => issues.push(issue));
    expect(jobs).toHaveLength(2);
    expect(issues).toEqual([{ source: adapter.ats, skipped: 1, message: `Skipped 1 invalid items: ${title}: invalid_type` }]);
  });

  it('rejects a feed whose every job is malformed instead of returning an empty collection', async () => {
    const bad = structuredClone(data);
    for (const row of list ? bad[list] : bad) row[title] = 42;
    serve(bad);
    await expect(adapter.fetchCompany(slug, 'Company')).rejects.toThrow(/all processable items invalid/);
  });

  it('rejects invalid JSON without returning an empty collection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{invalid')));
    await expect(adapter.fetchCompany(slug, 'Company')).rejects.toBeInstanceOf(HttpError);
  });
});

describe('publication dates and real field mappings', () => {
  it('maps Ashby Salary rather than equity or bonus, with the real publication date', async () => {
    serve(ashbyFixture);
    const [job] = await ashby.fetchCompany('ashby', 'Ashby');
    expect(job).toMatchObject({
      externalId: '7458d4e9-da2e-47bd-98cb-adfda43d42b2',
      title: 'Engineering Manager - EU', locationText: 'Remote - European Union', remoteHint: true,
      salary: { min: 150000, max: 250000, currency: 'EUR', period: 'year' },
      postedAt: new Date('2024-03-04T14:29:08.532Z'),
      url: 'https://jobs.ashbyhq.com/ashby/7458d4e9-da2e-47bd-98cb-adfda43d42b2',
      applyUrl: 'https://jobs.ashbyhq.com/ashby/7458d4e9-da2e-47bd-98cb-adfda43d42b2/application',
    });
  });

  it('decodes Greenhouse real entity-escaped content and uses first_published, not updated_at', async () => {
    expect(greenhouseFixture.jobs[0].content).toMatch(/^&lt;div/);
    serve(greenhouseFixture);
    const [job] = await greenhouse.fetchCompany('greenhouse', 'Greenhouse');
    expect(job).toMatchObject({
      externalId: '8126988', locationText: 'Eastern Timezone',
      postedAt: new Date('2026-08-24T17:52:04Z'), salary: null, remoteHint: null,
      url: 'https://job-boards.greenhouse.io/greenhouse/jobs/8126988?gh_jid=8126988',
      applyUrl: 'https://job-boards.greenhouse.io/greenhouse/jobs/8126988?gh_jid=8126988',
    });
    expect(job.descriptionText).toContain('Greenhouse is the first Orchestrated Hiring Ecosystem');
    expect(job.descriptionText).not.toContain('&lt;');
    expect(job.descriptionText).not.toContain('<div');
  });

  it('keeps Lever createdAt out of publication and includes lists and closing text', async () => {
    serve(leverFixture.jobs);
    const jobs = await lever.fetchCompany('palantir', 'Palantir');
    expect(jobs.map((j) => j.remoteHint)).toEqual([false, true, false]);
    expect(jobs.map((j) => j.postedAt)).toEqual([null, null, null]);
    expect(jobs[0]).toMatchObject({ externalId: '6ed76ce8-4156-4b60-b120-403538bd66cd', locationText: 'Singapore, Singapore', salary: null });
    expect(jobs[0].descriptionText).toContain('Administrative Business Partner (Foundry)');
    expect(jobs[0].descriptionText).toContain('Provide administrative support');
    expect(jobs[0].descriptionText).toContain('current right to work in Singapore');
  });

  it('maps Recruitee numeric-string salary and UTC publication, not creation/update time', async () => {
    serve(recruiteeFixture);
    const jobs = await recruitee.fetchCompany('jobs', 'Tellent');
    expect(jobs[0]).toMatchObject({
      externalId: '2797235', locationText: 'Amsterdam, Noord-Holland, Netherlands',
      salary: { min: 55000, max: 65000, currency: 'EUR', period: 'year' },
      postedAt: new Date('2026-10-28T14:11:44Z'),
      url: 'https://careers.tellent.com/o/customer-success-manager-tellent-hr',
      applyUrl: 'https://careers.tellent.com/o/customer-success-manager-tellent-hr/c/new',
    });
    expect(jobs.map((j) => j.remoteHint)).toEqual([false, false, true]);
  });
});

describe('synthetic edge cases', () => {
  it.each([
    [ashby, { jobs: [{ ...ashbyFixture.jobs[0], publishedAt: null }] }],
    [greenhouse, { jobs: [{ ...greenhouseFixture.jobs[0], first_published: undefined }] }],
    [recruitee, { offers: [{ ...recruiteeFixture.offers[0], published_at: null }] }],
  ] as const)('$ats keeps unknown publication null', async (adapter, data) => {
    serve(data);
    expect((await adapter.fetchCompany('example', 'Company'))[0].postedAt).toBeNull();
  });

  it.each([
    [ashby, { jobs: [{ ...ashbyFixture.jobs[0], publishedAt: 'not a date' }] }],
    [greenhouse, { jobs: [{ ...greenhouseFixture.jobs[0], first_published: '2026-02-31T00:00:00Z' }] }],
    [recruitee, { offers: [{ ...recruiteeFixture.offers[0], published_at: 'not a date' }] }],
  ] as const)('$ats rejects malformed publication dates', async (adapter, data) => {
    serve(data);
    await expect(adapter.fetchCompany('example', 'Company')).rejects.toThrow(/response/i);
  });

  it.each([
    [ashby, { jobs: [{ ...ashbyFixture.jobs[0], jobUrl: 'javascript:alert(1)' }] }],
    [greenhouse, { jobs: [{ ...greenhouseFixture.jobs[0], absolute_url: 'not a url' }] }],
    [lever, [{ ...leverFixture.jobs[0], hostedUrl: '' }]],
    [recruitee, { offers: [{ ...recruiteeFixture.offers[0], careers_url: 'ftp://example.test/job' }] }],
  ] as const)('$ats rejects invalid job URLs', async (adapter, data) => {
    serve(data);
    await expect(adapter.fetchCompany('example', 'Company')).rejects.toThrow(/response/i);
  });

  it('decodes exactly one Greenhouse provider layer while preserving literal encoded angle brackets', async () => {
    serve({ jobs: [{ ...greenhouseFixture.jobs[0], content: '&lt;p&gt;Use &amp;lt;Widget&amp;gt; &amp;amp; tools&lt;/p&gt;' }] });
    expect((await greenhouse.fetchCompany('example', 'Company'))[0].descriptionText).toBe('Use <Widget> & tools');
  });

  it('omits Ashby unlisted jobs as required by the source', async () => {
    serve({ jobs: [{ ...ashbyFixture.jobs[0], isListed: false }, ashbyFixture.jobs[1]] });
    expect((await ashby.fetchCompany('example', 'Company')).map((j) => j.externalId)).toEqual(['86a60834-ba64-484d-9658-afa1bc97a957']);
  });

  it('does not invent an Ashby salary from equity/bonus', async () => {
    serve({ jobs: [{ ...ashbyFixture.jobs[0], compensation: { summaryComponents: [{ compensationType: 'EquityPercentage', minValue: 1, maxValue: 2, interval: 'NONE', currencyCode: null }] } }] });
    expect((await ashby.fetchCompany('example', 'Company'))[0].salary).toBeNull();
  });

  it.each([
    [ashby, { jobs: [{ ...ashbyFixture.jobs[0], compensation: null, isRemote: undefined, location: null, applyUrl: null }] }],
    [greenhouse, { jobs: [{ ...greenhouseFixture.jobs[0], location: null }] }],
    [lever, [{ ...leverFixture.jobs[0], salaryRange: null, workplaceType: 'unspecified', categories: null, applyUrl: null }]],
    [recruitee, { offers: [{ ...recruiteeFixture.offers[0], salary: { min: null, max: null, period: null, currency: null }, remote: null, location: null, careers_apply_url: null }] }],
  ] as const)('$ats preserves unknown salary, location and remote hint', async (adapter, data) => {
    serve(data);
    expect((await adapter.fetchCompany('example', 'Company'))[0]).toMatchObject({ salary: null, locationText: null, remoteHint: null });
  });

  it.each([
    ['per-year-salary', 'year'], ['per-month-salary', 'month'], ['per-hour-wage', 'hour'], ['per-week-salary', null], ['toString', null],
  ])('maps Lever salary interval %s without inventing units', async (interval, period) => {
    serve([{ ...leverFixture.jobs[0], salaryRange: { min: 10, max: 20, currency: 'USD', interval }, salaryDescription: '<p>Pay detail</p>' }]);
    const [job] = await lever.fetchCompany('example', 'Company');
    expect(job.salary).toEqual({ min: 10, max: 20, currency: 'USD', period });
    expect(job.descriptionText).toContain('Pay detail');
  });

  it.each([['1 MONTH', 'month'], ['1 HOUR', 'hour'], ['1 WEEK', null], ['toString', null]])('maps Ashby salary interval %s', async (interval, period) => {
    serve({ jobs: [{ ...ashbyFixture.jobs[0], compensation: { summaryComponents: [{ compensationType: 'Salary', minValue: null, maxValue: 100, interval, currencyCode: 'EUR' }] } }] });
    expect((await ashby.fetchCompany('example', 'Company'))[0].salary).toEqual({ min: null, max: 100, currency: 'EUR', period });
  });

  it.each([['month', 'month'], ['hour', 'hour'], ['week', null]])('maps Recruitee salary period %s without turning null into zero', async (interval, period) => {
    serve({ offers: [{ ...recruiteeFixture.offers[0], salary: { min: null, max: '25.50', currency: 'EUR', period: interval }, requirements: '<p>Required skill</p>' }] });
    const [job] = await recruitee.fetchCompany('example', 'Company');
    expect(job.salary).toEqual({ min: null, max: 25.5, currency: 'EUR', period });
    expect(job.descriptionText).toContain('Required skill');
  });

  it('rejects malformed Recruitee salary rather than coercing it to zero', async () => {
    serve({ offers: [{ ...recruiteeFixture.offers[0], salary: { min: '', max: 'unknown', currency: 'EUR', period: 'year' } }] });
    await expect(recruitee.fetchCompany('example', 'Company')).rejects.toThrow(/salary/);
  });

  it.each([
    [ashby, ashbyFixture, 'https://api.ashbyhq.com/posting-api/job-board/Acme%20%2F%25%3F%23?includeCompensation=true'],
    [greenhouse, greenhouseFixture, 'https://boards-api.greenhouse.io/v1/boards/Acme%20%2F%25%3F%23/jobs?content=true'],
    [lever, leverFixture.jobs, 'https://api.lever.co/v0/postings/Acme%20%2F%25%3F%23?mode=json'],
    [recruitee, recruiteeFixture, 'https://Acme%20%2F%25%3F%23.recruitee.com/api/offers/'],
  ] as const)('$ats re-encodes decoded slugs and preserves identity case', async (adapter, data, url) => {
    serve(data, url);
    const jobs = await adapter.fetchCompany('Acme /%?#', 'Company');
    expect(jobs[0].companyAts?.slug).toBe('Acme /%?#');
  });
});

describe('Lever EU fallback', () => {
  it('retries exactly the encoded path on the EU host only after US 404', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(url);
      expect(new Headers(init?.headers).get('User-Agent')).toBe('RematchBot/0.1 (+https://github.com/rematch-app)');
      return calls.length === 1 ? new Response('', { status: 404 }) : Response.json(leverFixture.jobs);
    }));
    const jobs = await lever.fetchCompany('Acme /', 'Company');
    expect(jobs).toHaveLength(3);
    expect(jobs[0].companyAts).toEqual({ ats: 'lever', slug: 'Acme /' });
    expect(calls).toEqual([
      'https://api.lever.co/v0/postings/Acme%20%2F?mode=json',
      'https://api.eu.lever.co/v0/postings/Acme%20%2F?mode=json',
    ]);
  });

  it.each([401, 429, 500])('propagates US %s without switching region', async (status) => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_url: string) => new Response('', { status }));
    vi.stubGlobal('fetch', fetchMock);
    const outcome = lever.fetchCompany('example', 'Company').catch((error: unknown) => error);
    await vi.runAllTimersAsync();
    expect(await outcome).toMatchObject({ status });
    expect(fetchMock.mock.calls.length).toBe(status === 401 ? 1 : 3);
    for (const call of fetchMock.mock.calls) expect(call[0]).toBe('https://api.lever.co/v0/postings/example?mode=json');
  });

  it('propagates EU 404 without another fallback', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(lever.fetchCompany('example', 'Company')).rejects.toMatchObject({ status: 404, url: 'https://api.eu.lever.co/v0/postings/example?mode=json' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not switch hosts for a malformed successful response', async () => {
    const fetchMock = serve({ changed: true });
    await expect(lever.fetchCompany('example', 'Company')).rejects.toThrow(/lever.*response/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

it('provides all source credits and compatible collection interfaces', () => {
  const atsAdapters: AtsAdapter[] = [ashby, greenhouse, lever, recruitee];
  const board: BoardAdapter = { name: 'hn', async fetchJobs() { return []; } };
  expect(atsAdapters).toHaveLength(4);
  expect(credit[board.name]).toEqual({ name: 'Hacker News', url: 'https://news.ycombinator.com' });
  expect(credit).toEqual({
    ashby: { name: 'Ashby', url: 'https://www.ashbyhq.com' },
    greenhouse: { name: 'Greenhouse', url: 'https://www.greenhouse.com' },
    lever: { name: 'Lever', url: 'https://www.lever.co' },
    recruitee: { name: 'Recruitee', url: 'https://recruitee.com' },
    jobicy: { name: 'Jobicy', url: 'https://jobicy.com' },
    hn: { name: 'Hacker News', url: 'https://news.ycombinator.com' },
    wwr: { name: 'We Work Remotely', url: 'https://weworkremotely.com' },
    remoteok: { name: 'Remote OK', url: 'https://remoteok.com' },
    arbeitnow: { name: 'Arbeitnow', url: 'https://www.arbeitnow.com' },
  });
});
