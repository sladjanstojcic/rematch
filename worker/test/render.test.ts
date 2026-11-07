import { describe, expect, it } from 'vitest';
import { formatSalary, renderDigest, type DigestItem } from '../src/email/render.js';

const item: DigestItem = {
  title: 'Backend engineer', company: 'Acme', url: 'https://ats.example.test/job?x=1&y=2',
  reason: 'The listed salary meets your floor.', salaryText: '$230K–$252K / year', postedDaysAgo: 2, dateLabel: 'Posted',
  credits: [{ name: 'Greenhouse', url: 'https://ats.example.test/original' },
    { name: 'Jobicy', url: 'https://jobicy.example.test/original' }],
};

describe('renderDigest', () => {
  it('renders the complete item and every source URL in both parts', () => {
    const result = renderDigest('Sam', [item]);
    expect(result.subject).toBe('1 new remote match for you');
    expect(result.html).toContain('href="https://ats.example.test/job?x=1&amp;y=2"');
    for (const text of ['Backend engineer', 'Acme', item.reason, item.salaryText!, 'Posted 2 days ago',
      'Reply STOP to unsubscribe.', 'Sam']) {
      expect(result.html).toContain(text);
      expect(result.text).toContain(text);
    }
    expect(result.html.replace(/<[^>]*>/g, '')).toContain('via Greenhouse, Jobicy');
    for (const url of [item.url, ...item.credits.map((c) => c.url)]) expect(result.text).toContain(url);
    for (const credit of item.credits) expect(result.html).toContain(`href="${credit.url}"`);
  });

  it('uses plural subjects, tolerates missing name/salary, and keeps Remote OK followed', () => {
    const result = renderDigest(null, [item, { ...item, salaryText: null,
      credits: [{ name: 'Remote OK', url: 'https://remoteok.com/remote-jobs/123' }] }]);
    expect(result.subject).toBe('2 new remote matches for you');
    expect(result.html).toContain('Hi there,');
    expect(result.text).toMatch(/^Hi there,/);
    expect(result.html).toContain('href="https://remoteok.com/remote-jobs/123"');
    expect(result.html).not.toMatch(/nofollow|null|undefined/);
    expect(result.text).not.toMatch(/null|undefined/);
  });

  it.each([
    ['Posted', 0, 'Posted today'], ['Posted', 1, 'Posted 1 day ago'], ['Posted', 2, 'Posted 2 days ago'],
    ['First seen', 0, 'First seen today'], ['First seen', 1, 'First seen 1 day ago'], ['First seen', 2, 'First seen 2 days ago'],
  ] as const)('renders %s age %s truthfully in both parts', (dateLabel, postedDaysAgo, expected) => {
    const result = renderDigest('Sam', [{ ...item, dateLabel, postedDaysAgo }]);
    expect(result.html).toContain(expected);
    expect(result.text).toContain(expected);
    expect(result.html).not.toContain('1 days ago');
    expect(result.text).not.toContain('1 days ago');
    expect(result.text).not.toContain(' 0 days ago');
  });

  it('escapes untrusted names, content and URL attributes without allowing active links', () => {
    const result = renderDigest('<Sam>', [{ ...item, title: '<script>alert(1)</script>',
      company: 'A&B', reason: '"quoted" <b>reason</b>', url: 'https://example.test/" onclick="bad',
      credits: [{ name: '<credit>', url: 'javascript:alert(1)' }] }]);
    expect(result.html).toContain('&lt;Sam&gt;');
    expect(result.html).toContain('&lt;script&gt;');
    expect(result.html).toContain('A&amp;B');
    expect(result.html).not.toContain('<script>');
    expect(result.html).not.toContain('href="javascript:');
    expect(result.html).not.toContain('" onclick="bad');
    expect(result.text).toContain('<script>alert(1)</script>');
  });
});

describe('formatSalary', () => {
  it.each([
    [230000, 252000, 'USD', 'year', '$230K–$252K / year'],
    [80500, 99499, 'EUR', 'year', '€81K–€99K / year'],
    [35, 50, 'GBP', 'hour', '£35–£50 / hour'],
    [100000, 120000, 'CAD', 'year', 'CAD 100K–CAD 120K / year'],
    [100000, null, 'USD', 'year', 'From $100K / year'],
    [null, 150000, 'USD', 'year', 'Up to $150K / year'],
    [100000, 100000, 'USD', 'year', '$100K / year'],
    [0, 500, 'USD', 'month', '$0–$500 / month'],
    [100000, null, null, null, 'From 100K'],
    [null, null, 'USD', 'year', null],
  ])('formats %s/%s %s %s', (salary_min, salary_max, salary_currency, salary_period, expected) => {
    expect(formatSalary({ salary_min, salary_max, salary_currency, salary_period })).toBe(expected);
  });
});
