import { decodeHTML } from 'entities';

const LEGAL_SUFFIXES = new Set(['inc', 'ltd', 'gmbh', 'llc', 'bv', 'sa']);

export function htmlToText(html: string): string {
  // Match entire tags, including quoted attributes, before replacing boundaries.
  const text = html.replace(/<!--[\s\S]*?-->|<\/?[a-z][^>"']*(?:"[^"]*"[^>"']*|'[^']*'[^>"']*)*>/gi,
    (tag) => /^<br\b|^<\/p\s*>/i.test(tag) ? '\n' : '');
  // Decode after stripping markup so encoded angle brackets remain visible text.
  return decodeHTML(text).replace(/[^\S\n]+/g, ' ').replace(/ *\n */g, '\n').trim();
}

export function normalizeKey(company: string, title: string): string {
  const normalize = (text: string) => text.toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
  const companyWords = normalize(company).split(' ');
  while (LEGAL_SUFFIXES.has(companyWords.at(-1) ?? '')) companyWords.pop();
  return `${companyWords.join(' ')}|${normalize(title)}`;
}
