import type { Database } from '../db.types.js';

export type DigestItem = {
  title: string;
  company: string;
  url: string;
  reason: string;
  salaryText: string | null;
  postedDaysAgo: number;
  dateLabel: 'Posted' | 'First seen';
  credits: { name: string; url: string }[];
};

type SalaryFields = Pick<Database['public']['Tables']['jobs']['Row'],
  'salary_min' | 'salary_max' | 'salary_currency' | 'salary_period'>;

export function formatSalary(salary: SalaryFields): string | null {
  const { salary_min: min, salary_max: max, salary_currency: currency, salary_period: period } = salary;
  if (min === null && max === null) return null;
  const symbol = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : currency === 'GBP' ? '£'
    : currency ? `${currency} ` : '';
  const amount = (value: number) => `${symbol}${Math.abs(value) >= 1000 ? `${Math.round(value / 1000)}K` : value}`;
  const range = min === null ? `Up to ${amount(max!)}` : max === null ? `From ${amount(min)}`
    : min === max ? amount(min) : `${amount(min)}–${amount(max)}`;
  return `${range}${period ? ` / ${period}` : ''}`;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function link(label: string, url: string): string {
  // Source content is untrusted, including attributes and link schemes.
  let href = '#';
  try {
    if (['https:', 'http:'].includes(new URL(url).protocol)) href = url;
  } catch { /* An invalid source URL must not become an active link. */ }
  return `<a href="${escapeHtml(href)}" style="color:#245a42;text-decoration:underline">${escapeHtml(label)}</a>`;
}

export function renderDigest(name: string | null, items: DigestItem[]): { subject: string; html: string; text: string } {
  const subject = `${items.length} new remote ${items.length === 1 ? 'match' : 'matches'} for you`;
  const greeting = name ? `Hi ${name},` : 'Hi there,';
  const age = (item: DigestItem) => `${item.dateLabel} ${item.postedDaysAgo === 0 ? 'today'
    : `${item.postedDaysAgo} ${item.postedDaysAgo === 1 ? 'day' : 'days'} ago`}`;
  const footer = 'Reply STOP to unsubscribe.';
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#faf9f6;color:#242a26;font-family:ui-monospace,Consolas,monospace;font-size:15px;line-height:1.6">
<main style="max-width:640px;margin:0 auto;padding:32px 24px">
<p>${escapeHtml(greeting)}</p>
${items.map((item) => `<section style="padding:20px 0;border-bottom:1px solid #dce1da">
<h2 style="font-size:18px;line-height:1.4;margin:0 0 12px">${link(`${item.title} — ${item.company}`, item.url)}</h2>
<p style="margin:0 0 12px">${escapeHtml(item.reason)}</p>
${item.salaryText === null ? '' : `<p style="margin:0 0 8px">${escapeHtml(item.salaryText)}</p>`}
<p style="margin:0 0 8px;color:#525e55">${escapeHtml(age(item))}</p>
<p style="margin:0;font-size:13px">via ${item.credits.map((credit) => link(credit.name, credit.url)).join(', ')}</p>
</section>`).join('\n')}
<p style="margin:28px 0 0;font-size:13px">${footer}</p>
</main></body></html>`;
  const text = [greeting, ...items.map((item) => [
    `${item.title} — ${item.company}`, item.url, item.reason, item.salaryText,
    age(item),
    `via ${item.credits.map((credit) => `${credit.name} (${credit.url})`).join(', ')}`,
  ].filter((line) => line !== null).join('\n')), footer].join('\n\n');
  return { subject, html, text };
}
