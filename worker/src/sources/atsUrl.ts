import type { AtsName } from '../domain.js';

export function parseAtsUrl(url: string): { ats: AtsName; slug: string } | null {
  try {
    const input = url.trim();
    const parsed = new URL(/^[a-z][a-z\d+.-]*:/i.test(input) ? input : `https://${input}`);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;

    const recruitee = /^([^.]+)\.recruitee\.com$/.exec(parsed.hostname);
    if (recruitee) return { ats: 'recruitee', slug: recruitee[1] };

    let ats: AtsName;
    switch (parsed.hostname) {
      case 'boards.greenhouse.io':
      case 'job-boards.greenhouse.io':
        ats = 'greenhouse';
        break;
      case 'jobs.lever.co':
      case 'jobs.eu.lever.co':
        ats = 'lever';
        break;
      case 'jobs.ashbyhq.com':
        ats = 'ashby';
        break;
      default:
        return null;
    }

    // Decode exactly once; adapters encode this slug when building request URLs.
    const slug = decodeURIComponent(parsed.pathname.split('/')[1]);
    return slug ? { ats, slug } : null;
  } catch {
    return null;
  }
}
