import { execFile } from 'node:child_process';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { SupabaseClient } from '@supabase/supabase-js';
import { decodeHTMLAttribute } from 'entities';
import pLimit from 'p-limit';
import { loadConfig } from '../config.js';
import { AI_CONCURRENCY } from '../constants.js';
import { createDb } from '../db.js';
import type { Database } from '../db.types.js';
import type { AtsName } from '../domain.js';
import { parseAtsUrl } from '../sources/atsUrl.js';
import { fetchText, HttpError, USER_AGENT } from '../util/http.js';

const exec = promisify(execFile);
const TARBALL_URL = 'https://codeload.github.com/remoteintech/remote-jobs/tar.gz/refs/heads/main';

/** Only the upstream's single-line scalars are needed; body text is never discovery metadata. */
export function parseCompanyFile(md: string): { name: string; careersUrl: string | null } {
  const frontMatter = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(md)?.[1] ?? '';
  const field = (key: string): string => {
    const value = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(frontMatter)?.[1].trim() ?? '';
    if (value.startsWith('"')) {
      const quoted = /^"(?:[^"\\]|\\.)*"/.exec(value)?.[0];
      try { return quoted ? String(JSON.parse(quoted)).trim() : ''; } catch { return ''; }
    }
    if (value.startsWith("'")) return /^'((?:[^']|'')*)'/.exec(value)?.[1].replace(/''/g, "'").trim() ?? '';
    const plain = value.replace(/[ \t]+#.*$/, '').trim();
    return /^(?:null|~)$/i.test(plain) ? '' : plain;
  };
  return { name: field('title') || field('name'), careersUrl: field('careers_url') || null };
}

export async function resolveAts(
  careersUrl: string,
  fetchPage = fetchText,
): Promise<{ ats: AtsName; slug: string } | null> {
  const direct = parseAtsUrl(careersUrl);
  if (direct) return direct;
  try {
    const url = new URL(careersUrl);
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    const html = (await fetchPage(careersUrl))
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
    for (const tag of html.matchAll(/<[a-z](?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)) {
      for (const attribute of tag[0].matchAll(/\s+([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
        if (attribute[1].toLowerCase() !== 'href') continue;
        const value = decodeHTMLAttribute(attribute[2] ?? attribute[3] ?? attribute[4] ?? '');
        try {
          const ats = parseAtsUrl(new URL(value, url).href);
          if (ats) return ats;
        } catch { /* A malformed href does not hide later valid links. */ }
      }
    }
  } catch { /* Careers pages are best effort, including exhausted HTTP retries. */ }
  return null;
}

/** Internal discovery only. Retain identifiers in the DB, never the source list or pages. */
export async function seedRemoteintech(
  db: SupabaseClient<Database>,
  fetchPage = fetchText,
): Promise<{ resolved: number; total: number; failed: number }> {
  const dir = await mkdtemp(join(tmpdir(), 'rematch-remoteintech-'));
  try {
    const response = await fetch(TARBALL_URL, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpError(TARBALL_URL, response.status);
    }
    const archive = join(dir, 'source.tar.gz');
    await writeFile(archive, new Uint8Array(await response.arrayBuffer()));
    const { stdout } = await exec('tar', ['-tzf', archive], { maxBuffer: 16 * 1024 * 1024 });
    // Explicit members exclude traversal, nested paths, scripts and directory entries.
    const files = [...new Set(stdout.split('\n').filter((path) =>
      /^remote-jobs-main\/src\/companies\/[a-z\d_.-]+\.md$/i.test(path)))].sort();
    if (!files.length) throw new Error('Archive contains no company Markdown files');
    await exec('tar', ['-xzf', archive, '--no-same-owner', '--no-same-permissions', '-C', dir, ...files]);
    const companies = [];
    for (const file of files) {
      const path = join(dir, file);
      const info = await lstat(path);
      if (!info.isFile() || info.nlink !== 1) throw new Error('Archive company entry is not a regular unlinked file');
      companies.push(parseCompanyFile(await readFile(path, 'utf8')));
    }
    let failed = 0;
    const countedFetch: typeof fetchText = async (url) => {
      try { return await fetchPage(url); } catch (error) { failed++; throw error; }
    };
    const limit = pLimit(AI_CONCURRENCY);
    const resolved = await Promise.all(companies.map((company) => limit(async () => {
      if (!company.name || !company.careersUrl) return null;
      const ats = await resolveAts(company.careersUrl, countedFetch);
      return ats ? { name: company.name, ...ats, active: true, discovered_via: 'remoteintech' } : null;
    })));
    const rows = resolved.filter((row) => row !== null);
    if (rows.length) {
      const { error } = await db.from('companies').upsert(rows, { onConflict: 'ats,slug', ignoreDuplicates: true });
      if (error) throw new Error(`Company seed insert failed (${error.code})`);
    }
    return { resolved: rows.length, total: companies.length, failed };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    const result = await seedRemoteintech(createDb(loadConfig()));
    console.log(`resolved ${result.resolved} of ${result.total} companies`);
    console.log(`careers fetch failures: ${result.failed}`);
  } catch {
    // Do not print response bodies, configuration, credentials or downloaded content.
    console.error('Company seed failed');
    process.exitCode = 1;
  }
}
