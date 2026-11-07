-- Consecutive collect runs in which the company's ATS board returned HTTP 404.
-- A successful fetch resets it; the worker deactivates at its threshold.
alter table public.companies add column not_found_runs integer not null default 0
  check (not_found_runs >= 0);
