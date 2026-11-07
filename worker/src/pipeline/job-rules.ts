import { WINDOW_DAYS } from '../constants.js';
import type { Database } from '../db.types.js';

export function freshnessCutoff(now: Date = new Date()): string {
  return new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

/** Pass to .or() on a jobs query, including scoring: posted_at takes precedence. */
export function freshnessFilter(now: Date = new Date()): string {
  const cutoff = freshnessCutoff(now);
  return `posted_at.gte.${cutoff},and(posted_at.is.null,first_seen_at.gte.${cutoff})`;
}

// Shared by deterministic conversion and the description-only salary instructions.
export const USD_RATES = {
  USD: 1, EUR: 1.08, GBP: 1.27, CAD: 0.73, AUD: 0.66, CHF: 1.12,
  // Added currencies: approximate USD/unit = ECB USD/EUR divided by currency/EUR,
  // rounded to three significant digits, 2026-11-06. Original approved rates above stay fixed.
  // https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html
  PLN: 0.254, INR: 0.0106, SEK: 0.101, NOK: 0.106, DKK: 0.149, CZK: 0.0459,
  HUF: 0.00307, RON: 0.209, BRL: 0.182, MXN: 0.0535, JPY: 0.00632,
  SGD: 0.780, NZD: 0.554, ILS: 0.313,
} as const;
export const SALARY_PERIOD_MULTIPLIERS = { year: 1, month: 12, hour: 2080 } as const;
type StructuredSalary = Pick<Database['public']['Tables']['jobs']['Row'],
  'salary_min' | 'salary_max' | 'salary_currency' | 'salary_period'>;

/** null means no structured salary; otherwise these bounds override AI salary, even when null. */
export function normalizeStructuredSalary(salary: StructuredSalary): {
  salary_usd_year_min: number | null; salary_usd_year_max: number | null;
} | null {
  const { salary_min: min, salary_max: max, salary_currency: currency, salary_period: period } = salary;
  if (min === null && max === null && currency === null && period === null) return null;
  const code = currency?.trim().toUpperCase();
  const rate = code !== undefined && Object.hasOwn(USD_RATES, code) ? USD_RATES[code as keyof typeof USD_RATES] : null;
  const multiplier = period !== null && Object.hasOwn(SALARY_PERIOD_MULTIPLIERS, period)
    ? SALARY_PERIOD_MULTIPLIERS[period as keyof typeof SALARY_PERIOD_MULTIPLIERS] : null;
  const convert = (amount: number | null) => amount !== null && Number.isFinite(amount) && amount >= 0 && rate !== null && multiplier !== null
    ? Math.round(amount * rate * multiplier) : null;
  return { salary_usd_year_min: convert(min), salary_usd_year_max: convert(max) };
}
