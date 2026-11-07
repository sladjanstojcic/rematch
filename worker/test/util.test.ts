import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchJson, fetchText, HttpError } from '../src/util/http.js';
import { htmlToText, normalizeKey } from '../src/util/text.js';

describe('normalizeKey', () => {
  it('matches company case, punctuation, suffixes and trailing title whitespace', () => {
    expect(normalizeKey('Acme, Inc.', 'Senior Frontend Engineer'))
      .toBe('acme|senior frontend engineer');
    expect(normalizeKey('Acme, Inc.', 'Senior Frontend Engineer'))
      .toBe(normalizeKey('ACME', 'Senior Frontend Engineer '));
  });

  it.each(['inc', 'ltd', 'gmbh', 'llc', 'bv', 'sa'])('removes the legal suffix %s', (suffix) => {
    expect(normalizeKey(` Acme ${suffix.toUpperCase()}. `, ' Frontend   Engineer! '))
      .toBe('acme|frontend engineer');
  });

  it('removes repeated legal suffixes without stripping parts of words or title words', () => {
    expect(normalizeKey('Acme GmbH, Ltd.', 'LLC Engineer')).toBe('acme|llc engineer');
    expect(normalizeKey('Sa Software', 'Principal')).toBe('sa software|principal');
    expect(normalizeKey('Salsa', 'Engineer')).toBe('salsa|engineer');
  });

  it('preserves Unicode letters and numbers and collapses whitespace', () => {
    expect(normalizeKey('  Café 42, BV.\n', 'Développeur\tSenior')).toBe('café 42|développeur senior');
    expect(normalizeKey('', '')).toBe('|');
  });

  it('does not mistake the end of a Unicode company name for a legal suffix', () => {
    expect(normalizeKey('Mésa', 'Engineer')).toBe('mésa|engineer');
    expect(normalizeKey('Mésa LLC', 'Engineer')).toBe('mésa|engineer');
  });
});

describe('htmlToText', () => {
  it('decodes entities and separates paragraphs', () => {
    expect(htmlToText('<p>A &amp; B</p><p>C</p>')).toBe('A & B\nC');
  });

  it('handles break variants, inline tags and surrounding whitespace', () => {
    expect(htmlToText(' <p> A <strong>bold</strong><br>B<BR />C<br class="break">D</p> '))
      .toBe('A bold\nB\nC\nD');
  });

  it('decodes named, decimal and hexadecimal entities without stripping encoded text', () => {
    expect(htmlToText('<p>&copy; &eacute; &#65; &#x1F680; &lt;remote&gt; &amp;lt;</p>'))
      .toBe('© é A 🚀 <remote> &lt;');
    expect(htmlToText('A&nbsp;&nbsp;B')).toBe('A B');
  });

  it('strips comments and tags with quoted angle brackets', () => {
    expect(htmlToText('<p title="a > b">A<!-- hidden <br> --> <a title=\'c > d\'>B</a></p>'))
      .toBe('A B');
  });

  it('preserves plain text and handles empty input', () => {
    expect(htmlToText('Pay < 100 & unknown')).toBe('Pay < 100 & unknown');
    expect(htmlToText('')).toBe('');
  });
});

describe('HTTP utilities', () => {
  const url = 'https://example.test/jobs';
  const userAgent = 'RematchBot/0.1 (+https://github.com/rematch-app)';

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('parses JSON and sends the global User-Agent with the default timeout', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json({ jobs: [1] }));
    vi.stubGlobal('fetch', fetch);
    await expect(fetchJson<{ jobs: number[] }>(url)).resolves.toEqual({ jobs: [1] });
    expect(timeout).toHaveBeenCalledWith(20_000);
    const [requestedUrl, init] = fetch.mock.calls[0];
    expect(requestedUrl).toBe(url);
    expect(new Headers(init?.headers).get('user-agent')).toBe(userAgent);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ['text/html', '<html>Error</html>'],
    ['application/json', '{broken'],
  ])('throws HttpError for a non-JSON body (%s) without retrying', async (contentType, body) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body, {
      headers: { 'content-type': contentType },
    }));
    vi.stubGlobal('fetch', fetch);
    const error = await fetchJson(url).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ url, status: 200 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retries a 503 once after 500 ms then returns parsed JSON', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetch);
    const pending = fetchJson(url);
    await vi.advanceTimersByTimeAsync(499);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  describe.each([['fetchJson', fetchJson], ['fetchText', fetchText]] as const)('%s', (_name, request) => {
    it.each([429, 500, 599])('stops after two retries for HTTP %i, at 500 and 1500 ms', async (status) => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => new Response('error', { status }));
      vi.stubGlobal('fetch', fetch);
      const pending = request(url).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(500);
      expect(fetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1499);
      expect(fetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      const error = await pending;
      expect(error).toBeInstanceOf(HttpError);
      expect(error).toMatchObject({ url, status });
      expect(fetch).toHaveBeenCalledTimes(3);
      const signals = fetch.mock.calls.map(([, init]) => init?.signal);
      expect(new Set(signals).size).toBe(3);
      for (const [, init] of fetch.mock.calls) {
        expect(new Headers(init?.headers).get('user-agent')).toBe(userAgent);
      }
    });

    it('retries network failures and reports status 0 when no response arrives', async () => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError('network failed'));
      vi.stubGlobal('fetch', fetch);
      const pending = request(url).catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      const error = await pending;
      expect(error).toBeInstanceOf(HttpError);
      expect(error).toMatchObject({ url, status: 0 });
      expect(fetch).toHaveBeenCalledTimes(3);
    });

    it('does not retry other HTTP failures', async () => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('missing', { status: 404 }));
      vi.stubGlobal('fetch', fetch);
      const error = await request(url).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(HttpError);
      expect(error).toMatchObject({ url, status: 404 });
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('honors retries=0', async () => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('busy', { status: 503 }));
      vi.stubGlobal('fetch', fetch);
      await expect(request(url, { retries: 0 })).rejects.toMatchObject({ url, status: 503 });
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  });

  it('returns text unchanged with a custom timeout and retry count', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new TypeError('network failed'))
      .mockResolvedValueOnce(new Response('<p>Remote &amp; EU</p>'));
    vi.stubGlobal('fetch', fetch);
    const pending = fetchText(url, { timeoutMs: 1234, retries: 1 });
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBe('<p>Remote &amp; EU</p>');
    expect(timeout).toHaveBeenCalledTimes(2);
    expect(timeout).toHaveBeenNthCalledWith(1, 1234);
    expect(timeout).toHaveBeenNthCalledWith(2, 1234);
  });

  it('retries interrupted response bodies', async () => {
    const interrupted = new Response(new ReadableStream({
      start(controller) { controller.error(new TypeError('connection lost')); },
    }));
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(interrupted)
      .mockResolvedValueOnce(Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetch);
    const pending = fetchJson(url);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('aborts a stalled request at the configured timeout', async () => {
    vi.useRealTimers();
    vi.stubGlobal('fetch', vi.fn<typeof globalThis.fetch>().mockImplementation((_url, init) =>
      new Promise((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
      })));
    await expect(fetchText(url, { timeoutMs: 5, retries: 0 })).rejects.toMatchObject({ url, status: 0 });
  });
});
