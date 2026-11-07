export type AtsName = 'ashby' | 'greenhouse' | 'lever' | 'recruitee';
export type BoardName = 'jobicy' | 'hn' | 'wwr' | 'remoteok' | 'arbeitnow';
export type SourceName = AtsName | BoardName;

export const REGIONS = [
  'worldwide', 'north_america', 'latin_america', 'europe', 'eu', 'uk',
  'emea', 'apac', 'africa', 'middle_east',
] as const;
export type Region = (typeof REGIONS)[number];

export type RawJob = {
  source: SourceName;
  externalId: string;
  url: string;
  title: string;
  company: string;
  locationText: string | null;
  salary: {
    min: number | null;
    max: number | null;
    currency: string | null;
    period: 'year' | 'month' | 'hour' | null;
  } | null;
  descriptionText: string;
  postedAt: Date | null;
  applyUrl: string | null;
  remoteHint: boolean | null;
  companyAts?: { ats: AtsName; slug: string };
};
