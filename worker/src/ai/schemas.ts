import { z } from 'zod';
import { REGIONS } from '../domain.js';

const SenioritySchema = z.enum(['intern', 'junior', 'mid', 'senior', 'staff', 'principal', 'lead', 'unknown']);
const RoleFamilySchema = z.enum(['frontend', 'backend', 'fullstack', 'mobile', 'devops', 'data', 'ml', 'design', 'product', 'qa', 'security', 'other']);

export const EnrichmentSchema = z.object({
  is_remote: z.boolean(),
  regions: z.array(z.enum(REGIONS)),
  countries: z.array(z.string().regex(/^[A-Z]{2}$/)),
  // Preprocess only unknown strings; the output enums preserve SDK JSON schema
  // and inferred types. Subscriber constraints below retain strict validation.
  seniority: z.preprocess((value) => typeof value === 'string' && !SenioritySchema.safeParse(value).success ? 'unknown' : value, SenioritySchema),
  role_family: z.preprocess((value) => typeof value === 'string' && !RoleFamilySchema.safeParse(value).success ? 'other' : value, RoleFamilySchema),
  technologies: z.array(z.string()),
  salary_usd_year_min: z.number().int().nonnegative().nullable(),
  salary_usd_year_max: z.number().int().nonnegative().nullable(),
  company_size: z.number().int().nonnegative().nullable(),
  // overwrite preserves the JSON-schema string/length hint while normalizing
  // before SDK validation. Idempotent because createCaller validates again.
  summary: z.string().overwrite((text) => text.trim().slice(0, 160).replace(/[\uD800-\uDBFF]$/, '').trimEnd()).max(160),
});

export type Enrichment = z.infer<typeof EnrichmentSchema>;
export type Seniority = Enrichment['seniority'];
export type RoleFamily = Enrichment['role_family'];

export const ConstraintsSchema = z.object({
  salary_floor_usd_year: z.number().int().nonnegative().nullable(),
  seniority_allowed: z.array(SenioritySchema),
  role_families: z.array(RoleFamilySchema),
  country: z.string().regex(/^[A-Z]{2}$/),
  regions: z.array(z.enum(REGIONS)),
});

export type Constraints = z.infer<typeof ConstraintsSchema>;

export const ScoreBatchSchema = z.object({
  results: z.array(z.object({
    job_id: z.string(), score: z.number().int().min(0).max(100), reason: z.string(),
  })),
});
