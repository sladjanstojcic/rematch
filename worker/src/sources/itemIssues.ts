import type { z } from 'zod';
import type { RawJob, SourceName } from '../domain.js';
import type { SourceIssueHandler } from './types.js';

/** Per-call aggregate; filtered/deleted records are not invalid processable items. */
export function createItemIssues(source: SourceName, onIssue?: SourceIssueHandler) {
  let skipped = 0;
  const reasons = new Set<string>();
  function skip(reason: string) {
    skipped++;
    if (reasons.size < 3) reasons.add(reason.slice(0, 160));
  }
  return {
    skip,
    parse<T>(schema: z.ZodType<T>, data: unknown): T | undefined {
      const result = schema.safeParse(data);
      if (result.success) return result.data;
      const issue = result.error.issues[0];
      // Field/code only: never copy remote payloads or arbitrary error text into run logs.
      skip(`${issue.path.join('.') || 'item'}: ${issue.code}`);
      return undefined;
    },
    finish(jobs: RawJob[]): RawJob[] {
      if (skipped) {
        const message = `Skipped ${skipped} invalid items: ${[...reasons].join('; ')}`;
        onIssue?.({ source, skipped, message });
        if (!jobs.length) throw new Error(`Invalid ${source} response: all processable items invalid. ${message}`);
      }
      return jobs;
    },
  };
}

/** Parse a source envelope, reporting only the first issue's path and code. */
export function parseEnvelope<T>(label: string, schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw new Error(`Invalid ${label} response: ${issue.path.join('.') || 'response'}.${issue.code}`, { cause: result.error });
}
