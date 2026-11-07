import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseCompanyFile, resolveAts, seedRemoteintech } from '../src/seed/remoteintech.js';
import { resetDb, testDb, withTestSql } from './helpers/db.js';

const exec = promisify(execFile);
const tarballUrl = 'https://codeload.github.com/remoteintech/remote-jobs/tar.gz/refs/heads/main';
const userAgent = 'RematchBot/0.1 (+https://github.com/rematch-app)';
const realFetch = globalThis.fetch;
const profile = (name: string, url?: string) => `---\ntitle: "${name}"\n${url ? `careers_url: ${url}\n` : ''}---\n`;

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('parseCompanyFile', () => {
  it('reads the upstream quoted title and plain careers_url from front matter only', () => {
    expect(parseCompanyFile('---\ntitle: "Acme"\nslug: acme\ncareers_url: https://acme.example.test/careers\nregion: worldwide\n---\ncareers_url: https://wrong.example.test'))
      .toEqual({ name: 'Acme', careersUrl: 'https://acme.example.test/careers' });
  });
  it('accepts name as a fallback and YAML single-quoted scalars with CRLF', () => {
    expect(parseCompanyFile("---\r\nname: 'Acme''s Team'\r\ncareers_url: 'https://acme.example.test/careers'\r\n---\r\n"))
      .toEqual({ name: "Acme's Team", careersUrl: 'https://acme.example.test/careers' });
  });
  it('prefers title and preserves escaped quotes and URL fragments', () => {
    expect(parseCompanyFile('---\ntitle: "Acme \\"Team\\""\nname: Wrong\ncareers_url: https://acme.example.test/#jobs # comment\n---\n'))
      .toEqual({ name: 'Acme "Team"', careersUrl: 'https://acme.example.test/#jobs' });
  });
  it.each(['', 'careers_url:\n', 'careers_url: null\n', 'careers_url: ~\n', 'careers_url: ""\n'])('handles missing/empty careers URL: %j', (field) => {
    expect(parseCompanyFile(`---\ntitle: Acme\n${field}---\n`)).toEqual({ name: 'Acme', careersUrl: null });
  });
  it.each(['', 'title: Body only\ncareers_url: https://wrong.example.test', '---\ntitle: Unclosed', '---\ncareers_url: https://acme.example.test\n---\n'])('does not invent names or read body text: %j', (md) => {
    expect(parseCompanyFile(md).name).toBe('');
  });
  it('does not treat a YAML example in the Markdown body as front matter', () => {
    expect(parseCompanyFile('# Body\n\n---\ntitle: Wrong\ncareers_url: https://wrong.example.test\n---\n'))
      .toEqual({ name: '', careersUrl: null });
  });
});

describe('resolveAts', () => {
  it.each([
    ['https://jobs.lever.co/acme', 'lever'],
    ['https://jobs.eu.lever.co/acme', 'lever'],
    ['https://boards.greenhouse.io/acme', 'greenhouse'],
    ['https://job-boards.greenhouse.io/acme', 'greenhouse'],
    ['https://jobs.ashbyhq.com/acme', 'ashby'],
    ['https://acme.recruitee.com', 'recruitee'],
  ])('resolves direct ATS URL %s without fetching', async (url, ats) => {
    const fetchPage = vi.fn().mockRejectedValue(new Error('must not fetch'));
    expect(await resolveAts(url, fetchPage)).toEqual({ ats, slug: 'acme' });
    expect(fetchPage).not.toHaveBeenCalled();
  });
  it('fetches once and uses the first supported HTML href', async () => {
    const fetchPage = vi.fn().mockResolvedValue('<a href="/about">About</a><a href="https://jobs.ashbyhq.com/acme">Jobs</a><a href="https://jobs.lever.co/other">Other</a>');
    expect(await resolveAts('https://acme.example.test/careers', fetchPage)).toEqual({ ats: 'ashby', slug: 'acme' });
    expect(fetchPage).toHaveBeenCalledExactlyOnceWith('https://acme.example.test/careers');
  });
  it('supports single quotes, unquoted hrefs, protocol-relative URLs and HTML entities', async () => {
    expect(await resolveAts('https://acme.example.test/careers', async () => "<a HREF='//jobs.lever.co/acme&#45;team?x=1&amp;y=2'>"))
      .toEqual({ ats: 'lever', slug: 'acme-team' });
    expect(await resolveAts('https://acme.example.test/careers', async () => '<a href=https://jobs.ashbyhq.com/acme>'))
      .toEqual({ ats: 'ashby', slug: 'acme' });
  });
  it('ignores lookalike hosts, non-href text, comments, scripts and data-href attributes', async () => {
    expect(await resolveAts('https://acme.example.test/careers', async () => '<!-- <a href="https://jobs.lever.co/comment"> --><script>const x=\'<a href="https://jobs.lever.co/script">\';</script><a data-href="https://jobs.lever.co/data">https://jobs.lever.co/text</a><a href="https://jobs.lever.co.evil.test/acme">'))
      .toBeNull();
  });
  it('ignores href text inside another attribute and handles quoted angle brackets', async () => {
    expect(await resolveAts('https://acme.example.test/careers', async () => '<a title=\'example href="https://jobs.lever.co/wrong"\' href="https://jobs.ashbyhq.com/right">'))
      .toEqual({ ats: 'ashby', slug: 'right' });
    expect(await resolveAts('https://acme.example.test/careers', async () => '<a title="Jobs > more" href="https://jobs.ashbyhq.com/right">'))
      .toEqual({ ats: 'ashby', slug: 'right' });
  });
  it('returns null for no ATS href or a fetch failure', async () => {
    expect(await resolveAts('https://acme.example.test/careers', async () => '<a href="/jobs">Jobs</a>')).toBeNull();
    expect(await resolveAts('https://acme.example.test/careers', async () => { throw new Error('offline'); })).toBeNull();
  });
  it('does not fetch a non-web URL', async () => {
    const fetchPage = vi.fn();
    expect(await resolveAts('mailto:jobs@acme.example.test', fetchPage)).toBeNull();
    expect(fetchPage).not.toHaveBeenCalled();
  });
  it('uses fetchText defaults including the UA, timeout and transient retries', async () => {
    vi.useFakeTimers();
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetch = vi.fn<typeof realFetch>()
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(new Response('<a href="https://jobs.ashbyhq.com/acme">'));
    vi.stubGlobal('fetch', fetch);
    const pending = resolveAts('https://acme.example.test/careers');
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toEqual({ ats: 'ashby', slug: 'acme' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(timeout).toHaveBeenCalledWith(20_000);
    for (const [, init] of fetch.mock.calls) expect(new Headers(init?.headers).get('User-Agent')).toBe(userAgent);
  });
});

// Synthetic archives only: no upstream list, credentials or live career pages in tests.
async function archive(files: Record<string, string>, link = false): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'rematch-t11-fixture-'));
  try {
    for (const [name, body] of Object.entries(files)) {
      const path = join(dir, 'remote-jobs-main', 'src', 'companies', name);
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, body);
    }
    await writeFile(join(dir, 'remote-jobs-main', 'unrelated.sh'), 'exit 99');
    if (link) await symlink('../outside.md', join(dir, 'remote-jobs-main/src/companies/link.md'));
    const file = join(dir, 'fixture.tar.gz');
    await exec('tar', ['-czf', file, '-C', dir, 'remote-jobs-main']);
    return await readFile(file);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
async function tempDirs() {
  return (await readdir(tmpdir())).filter((name) => name.startsWith('rematch-remoteintech-')).sort();
}
function stubDownload(bytes: Buffer, status = 200) {
  const fetch = vi.fn<typeof realFetch>().mockImplementation(async (input, init) => {
    if (String(input).startsWith('http://127.0.0.1:54321/')) return realFetch(input, init);
    if (String(input) !== tarballUrl) throw new Error(`Unexpected external request: ${input}`);
    return new Response(new Uint8Array(bytes), { status });
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

describe('seedRemoteintech with owned local DB', () => {
  let db: ReturnType<typeof testDb>;
  beforeAll(() => { db = testDb(); });
  beforeEach(resetDb);

  it('inserts resolved companies, counts failures, ignores conflicts and cleans up on repeat runs', async () => {
    await db.from('companies').insert({ name: 'Board name', ats: 'lever', slug: 'existing', active: false, discovered_via: 'jobicy' }).throwOnError();
    const before = await withTestSql((sql) => sql`select * from companies where slug = 'existing'`);
    const bytes = await archive({
      'a.md': profile('Replacement', 'https://jobs.lever.co/existing'),
      'b.md': profile('New company', 'https://new.example.test/careers'),
      'c.md': profile('No URL'),
      'd.md': profile('No ATS', 'https://no-ats.example.test/careers'),
      'e.md': profile('Offline', 'https://offline.example.test/careers'),
      'f.md': profile('Duplicate', 'https://jobs.ashbyhq.com/new'),
    });
    const fetch = stubDownload(bytes);
    const fetchPage = vi.fn(async (url: string) => {
      if (url.includes('offline')) throw new Error('offline');
      return url.includes('no-ats') ? '<p>No jobs</p>' : '<a href="https://jobs.ashbyhq.com/new">';
    });
    const temps = await tempDirs();
    for (let run = 0; run < 2; run++) {
      expect(await seedRemoteintech(db, fetchPage)).toEqual({ resolved: 3, total: 6, failed: 1 });
      expect(await tempDirs()).toEqual(temps);
    }
    expect(fetchPage).toHaveBeenCalledTimes(6);
    const downloads = fetch.mock.calls.filter(([url]) => String(url) === tarballUrl);
    expect(downloads).toHaveLength(2);
    for (const [, init] of downloads) expect(new Headers(init?.headers).get('User-Agent')).toBe(userAgent);
    expect(await withTestSql((sql) => sql`select * from companies where slug = 'existing'`)).toEqual(before);
    expect(await withTestSql((sql) => sql`select name, ats, slug, active, discovered_via from companies order by slug`)).toEqual([
      { name: 'Board name', ats: 'lever', slug: 'existing', active: false, discovered_via: 'jobicy' },
      { name: 'New company', ats: 'ashby', slug: 'new', active: true, discovered_via: 'remoteintech' },
    ]);
  });

  it('bounds career-page resolution at five concurrent GETs', async () => {
    stubDownload(await archive(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`${i}.md`, profile(`Company ${i}`, `https://c${i}.example.test/careers`)]))));
    let active = 0, max = 0;
    const fetchPage = vi.fn(async () => {
      active++; max = Math.max(max, active);
      await new Promise((done) => setTimeout(done, 10));
      active--;
      return '<a href="https://jobs.lever.co/shared">';
    });
    expect(await seedRemoteintech(db, fetchPage)).toEqual({ resolved: 12, total: 12, failed: 0 });
    expect(max).toBe(5);
    expect(fetchPage).toHaveBeenCalledTimes(12);
    expect(await withTestSql((sql) => sql`select count(*)::int as n from companies`)).toEqual([{ n: 1 }]);
  });

  it.each(['download', 'invalid gzip', 'no companies', 'symlink', 'database'])('cleans its temporary directory after %s failure', async (failure) => {
    const files: Record<string, string> = failure === 'no companies' ? { 'not-a-company.txt': 'fixture' } : { 'acme.md': profile('Acme', 'https://jobs.lever.co/acme') };
    const bytes = failure === 'invalid gzip' ? Buffer.from('invalid') : await archive(files, failure === 'symlink');
    stubDownload(bytes, failure === 'download' ? 503 : 200);
    const temps = await tempDirs();
    // Rejected REST writes remain fake; all ordinary integration writes use the owned DB.
    if (failure === 'database') vi.spyOn(db, 'from').mockImplementation(() => { throw new Error('fixture DB write failure'); });
    await expect(seedRemoteintech(db)).rejects.toThrow();
    expect(await tempDirs()).toEqual(temps);
    expect(await withTestSql((sql) => sql`select count(*)::int as n from companies`)).toEqual([{ n: 0 }]);
  });
});
