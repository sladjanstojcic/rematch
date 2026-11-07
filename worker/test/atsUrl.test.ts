import { describe, expect, it } from 'vitest';
import { parseAtsUrl } from '../src/sources/atsUrl.js';

describe('parseAtsUrl', () => {
  it.each([
    ['boards.greenhouse.io/acme/jobs/123', { ats: 'greenhouse', slug: 'acme' }],
    ['job-boards.greenhouse.io/acme/jobs/1', { ats: 'greenhouse', slug: 'acme' }],
    ['jobs.lever.co/acme/uuid', { ats: 'lever', slug: 'acme' }],
    ['jobs.eu.lever.co/acme/x', { ats: 'lever', slug: 'acme' }],
    ['jobs.ashbyhq.com/Acme%20Inc/abc', { ats: 'ashby', slug: 'Acme Inc' }],
    ['acme.recruitee.com/o/dev', { ats: 'recruitee', slug: 'acme' }],
    ['example.com/careers', null],
  ])('recognizes %s with or without an HTTP scheme', (url, expected) => {
    expect(parseAtsUrl(url)).toEqual(expected);
    expect(parseAtsUrl(`https://${url}`)).toEqual(expected);
    expect(parseAtsUrl(`http://${url}`)).toEqual(expected);
  });

  it('ignores query/fragment and preserves slug case', () => {
    expect(parseAtsUrl('https://JOBS.LEVER.CO/Acme/jobs?source=board#apply'))
      .toEqual({ ats: 'lever', slug: 'Acme' });
  });

  it.each([
    ['Acme%2520Inc', 'Acme%20Inc'],
    ['Acme%2FInc', 'Acme/Inc'],
    ['Acme+Inc', 'Acme+Inc'],
    ['Caf%C3%A9', 'Café'],
  ])('decodes slug %s exactly once', (encoded, slug) => {
    expect(parseAtsUrl(`https://jobs.ashbyhq.com/${encoded}/job`))
      .toEqual({ ats: 'ashby', slug });
  });

  it.each([
    '', 'not a url', 'https://',
    'https://jobs.ashbyhq.com/',
    'https://boards.greenhouse.io',
    'https://jobs.lever.co//job',
    'https://jobs.ashbyhq.com/bad%ZZ/job',
    'https://jobs.lever.co/%E0%A4/job',
    'https://jobs.lever.co.evil.test/acme/job',
    'https://evil.test/jobs.lever.co/acme',
    'https://recruitee.com/o/dev',
    'https://acme.recruitee.com.evil.test/o/dev',
    'https://a.b.recruitee.com/o/dev',
    'ftp://jobs.lever.co/acme/job',
    'javascript:jobs.lever.co/acme/job',
    'mailto:jobs.lever.co/acme/job',
  ])('returns null for unsupported or malformed URL %j', (url) => {
    expect(parseAtsUrl(url)).toBeNull();
  });
});
