import type { AtsName, BoardName, RawJob, SourceName } from '../domain.js';

export interface AtsAdapter {
  ats: AtsName;
  fetchCompany(slug: string, companyName: string, onIssue?: SourceIssueHandler): Promise<RawJob[]>;
}

export type SourceIssue = { source: SourceName; skipped: number; message: string };
export type SourceIssueHandler = (issue: SourceIssue) => void;

export interface BoardAdapter {
  name: BoardName;
  fetchJobs(onIssue?: SourceIssueHandler): Promise<RawJob[]>;
}

export const credit: Record<SourceName, { name: string; url: string }> = {
  ashby: { name: 'Ashby', url: 'https://www.ashbyhq.com' },
  greenhouse: { name: 'Greenhouse', url: 'https://www.greenhouse.com' },
  lever: { name: 'Lever', url: 'https://www.lever.co' },
  recruitee: { name: 'Recruitee', url: 'https://recruitee.com' },
  jobicy: { name: 'Jobicy', url: 'https://jobicy.com' },
  hn: { name: 'Hacker News', url: 'https://news.ycombinator.com' },
  wwr: { name: 'We Work Remotely', url: 'https://weworkremotely.com' },
  remoteok: { name: 'Remote OK', url: 'https://remoteok.com' },
  arbeitnow: { name: 'Arbeitnow', url: 'https://www.arbeitnow.com' },
};
