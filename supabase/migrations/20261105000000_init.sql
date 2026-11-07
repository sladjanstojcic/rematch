create table public.subscribers (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  name text,
  prompt text not null,
  location text not null,
  constraints jsonb,
  prompt_hash text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  ats text not null check (ats in ('ashby', 'greenhouse', 'lever', 'recruitee')),
  slug text not null,
  active boolean not null default true,
  last_remote_job_at timestamptz,
  discovered_via text not null,
  created_at timestamptz not null default now(),
  unique (ats, slug)
);

create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  dedupe_key text unique not null,
  title text not null,
  company text not null,
  location_text text,
  salary_min numeric,
  salary_max numeric,
  salary_currency text,
  salary_period text,
  description text not null,
  posted_at timestamptz,
  first_seen_at timestamptz not null default now(),
  status text not null default 'open' check (status in ('open', 'closed')),
  company_id uuid references public.companies,
  created_at timestamptz not null default now()
);

create table public.job_sources (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs on delete cascade,
  source text not null,
  external_id text not null,
  url text not null,
  apply_url text,
  remote_hint boolean,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (source, external_id)
);

create table public.job_enrichment (
  job_id uuid primary key references public.jobs on delete cascade,
  is_remote boolean not null,
  regions text[] not null default '{}' check (
    regions <@ array['worldwide', 'north_america', 'latin_america', 'europe', 'eu', 'uk', 'emea', 'apac', 'africa', 'middle_east']::text[]
  ),
  countries text[] not null default '{}',
  seniority text,
  role_family text,
  technologies text[] not null default '{}',
  salary_usd_year_min int,
  salary_usd_year_max int,
  company_size int,
  summary text,
  created_at timestamptz not null default now()
);

create table public.matches (
  id uuid primary key default gen_random_uuid(),
  subscriber_id uuid not null references public.subscribers on delete cascade,
  job_id uuid not null references public.jobs on delete cascade,
  score int not null,
  reason text not null,
  is_match boolean not null,
  catchup boolean not null default false,
  suppressed boolean not null default false,
  emailed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (subscriber_id, job_id)
);

create table public.runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running',
  stats jsonb not null default '{}',
  errors jsonb not null default '[]',
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  est_cost_usd numeric not null default 0,
  created_at timestamptz not null default now()
);

-- A new row for each successful prompt refresh, even when a previous hash repeats.
-- Membership is frozen at refresh time, independently of enrichment/scoring progress.
create table public.catchup_cycles (
  id uuid primary key default gen_random_uuid(),
  ordinal bigint generated always as identity unique,
  subscriber_id uuid not null references public.subscribers on delete cascade,
  prompt_hash text not null,
  closed_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.catchup_members (
  cycle_id uuid not null references public.catchup_cycles on delete cascade,
  job_id uuid not null references public.jobs on delete cascade,
  created_at timestamptz not null default now(),
  primary key (cycle_id, job_id)
);

-- Set before the outbound poll, including attempts that return no jobs or fail.
create table public.source_poll_state (
  source text primary key,
  last_attempt_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index jobs_posted_at_idx on public.jobs (posted_at);
create index jobs_first_seen_at_idx on public.jobs (first_seen_at);
create index matches_unsent_subscriber_idx on public.matches (subscriber_id) where emailed_at is null;
create index catchup_cycles_subscriber_ordinal_idx on public.catchup_cycles (subscriber_id, ordinal desc);
create index catchup_members_job_idx on public.catchup_members (job_id);

alter table public.subscribers enable row level security;
alter table public.companies enable row level security;
alter table public.jobs enable row level security;
alter table public.job_sources enable row level security;
alter table public.job_enrichment enable row level security;
alter table public.matches enable row level security;
alter table public.runs enable row level security;
alter table public.catchup_cycles enable row level security;
alter table public.catchup_members enable row level security;
alter table public.source_poll_state enable row level security;

-- Explicit privileges support the CLI's current default of not auto-exposing tables.
revoke all on public.subscribers, public.companies, public.jobs, public.job_sources,
  public.job_enrichment, public.matches, public.runs, public.catchup_cycles,
  public.catchup_members, public.source_poll_state from public, anon, authenticated;
grant all on public.subscribers, public.companies, public.jobs, public.job_sources,
  public.job_enrichment, public.matches, public.runs, public.catchup_cycles,
  public.catchup_members, public.source_poll_state to service_role;
