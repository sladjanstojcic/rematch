import { describe, expect, it } from 'vitest';
import { ConstraintsSchema, type Constraints, type Enrichment } from '../src/ai/schemas.js';
import { normalizeStructuredSalary } from '../src/pipeline/job-rules.js';
import { passesPrefilter, prefilterRejectionReason } from '../src/pipeline/prefilter.js';

const constraints: Constraints = {
  salary_floor_usd_year: 80_000, seniority_allowed: ['mid', 'senior'],
  role_families: ['frontend'], country: 'RS', regions: ['europe', 'emea'],
};
const enrichment: Enrichment = {
  is_remote: true, regions: ['europe'], countries: [], seniority: 'senior', role_family: 'frontend',
  technologies: [], salary_usd_year_min: null, salary_usd_year_max: 90_000,
  company_size: null, summary: 'Build interfaces.',
};

describe('passesPrefilter', () => {
  it.each([
    ['US-only', { regions: ['north_america'], countries: ['US'] }, false],
    ['EMEA', { regions: ['emea'] }, true],
    ['unknown geography', { regions: [], countries: [] }, true],
    ['worldwide', { regions: ['worldwide'] }, true],
    ['65000 USD maximum', { salary_usd_year_max: 65_000 }, false],
    ['unknown salary', { salary_usd_year_max: null }, true],
    ['fullstack includes frontend', { role_family: 'fullstack' }, true],
    ['backend excludes frontend', { role_family: 'backend' }, false],
    ['not remote', { is_remote: false }, false],
    ['unknown seniority', { seniority: 'unknown' }, true],
    ['country-only RS', { regions: [], countries: ['RS'] }, true],
    ['country-only DE', { regions: [], countries: ['DE'] }, false],
    ['EU-only excludes Serbia', { regions: ['eu'] }, false],
    ['salary exactly at floor', { salary_usd_year_max: 80_000 }, true],
    ['disallowed seniority', { seniority: 'junior' }, false],
    ['other role is not unknown', { role_family: 'other' }, false],
  ] satisfies [string, Partial<Enrichment>, boolean][])('%s → %s', (_name, patch, want) => {
    expect(passesPrefilter({ enrichment: { ...enrichment, ...patch } }, constraints)).toBe(want);
  });

  it('accepts EUR 75000/year after shared normalization to USD 81000', () => {
    const salary = normalizeStructuredSalary({ salary_min: null, salary_max: 75_000, salary_currency: 'EUR', salary_period: 'year' });
    expect(salary).toEqual({ salary_usd_year_min: null, salary_usd_year_max: 81_000 });
    expect(passesPrefilter({ enrichment: { ...enrichment, ...salary } }, constraints)).toBe(true);
  });

  it.each([
    ['no floor', { salary_floor_usd_year: null }, { salary_usd_year_max: 1 }],
    ['any seniority', { seniority_allowed: [] }, { seniority: 'intern' }],
    ['any role', { role_families: [] }, { role_family: 'other' }],
    ['fullstack includes backend', { role_families: ['backend'] }, { role_family: 'fullstack' }],
  ] satisfies [string, Partial<Constraints>, Partial<Enrichment>][])('%s', (_name, c, e) => {
    expect(passesPrefilter({ enrichment: { ...enrichment, ...e } }, { ...constraints, ...c })).toBe(true);
  });
});

describe('prefilter rejection reasons', () => {
  it.each([
    [{ is_remote: false }, 'not_remote'],
    [{ regions: [], countries: ['US'] }, 'region'],
    [{ salary_usd_year_max: 60_000 }, 'salary'],
    [{ seniority: 'junior' }, 'seniority'],
    [{ role_family: 'design' }, 'role'],
    [{ regions: [], countries: [], salary_usd_year_max: null, seniority: 'unknown' }, null],
    [{ is_remote: false, salary_usd_year_max: 1, seniority: 'junior' }, 'not_remote'],
  ] satisfies [Partial<Enrichment>, string | null][])('classifies %j as %s once', (patch, reason) => {
    expect(prefilterRejectionReason({ enrichment: { ...enrichment, ...patch } }, constraints)).toBe(reason);
    expect(passesPrefilter({ enrichment: { ...enrichment, ...patch } }, constraints)).toBe(reason === null);
  });
});

describe('ConstraintsSchema', () => {
  it('accepts the required nullable/empty fields', () => {
    expect(ConstraintsSchema.parse({ ...constraints, salary_floor_usd_year: null, seniority_allowed: [], role_families: [] }))
      .toMatchObject({ salary_floor_usd_year: null, seniority_allowed: [], role_families: [] });
  });
  it.each([
    { country: 'Serbia' }, { country: 'rs' }, { regions: ['serbia'] },
    { seniority_allowed: ['expert'] }, { role_families: ['engineer'] },
    { salary_floor_usd_year: -1 }, { salary_floor_usd_year: 1.5 },
  ])('rejects malformed constraints: %j', (patch) => {
    expect(ConstraintsSchema.safeParse({ ...constraints, ...patch }).success).toBe(false);
  });
});
