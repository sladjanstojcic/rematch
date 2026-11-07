-- Grouping is deliberately non-unique: it only narrows identity candidates.
alter table public.jobs add column collect_key text;
create index jobs_collect_key_idx on public.jobs (collect_key);
-- An ATS source belongs to the company actually fetched, never a discovered link.
alter table public.job_sources add column company_id uuid references public.companies;
alter table public.job_sources add column stale_at timestamptz;
create index job_sources_job_id_idx on public.job_sources (job_id);
create index job_sources_company_source_seen_idx on public.job_sources (company_id, source, last_seen_at);
update public.job_sources s set company_id = j.company_id
from public.jobs j join public.companies c on c.id = j.company_id
where s.job_id = j.id and s.source = c.ats;

-- Use the database clock at the actual attempt (not a potentially earlier run start).
-- ON CONFLICT's predicate is checked under the row lock, including concurrent claims.
create function public.claim_jobicy_poll() returns boolean
language plpgsql security invoker set search_path = '' as $$
declare
  claimed text;
  attempted_at timestamptz := clock_timestamp();
begin
  insert into public.source_poll_state (source, last_attempt_at)
  values ('jobicy', attempted_at)
  on conflict (source) do update set last_attempt_at = excluded.last_attempt_at
    where public.source_poll_state.last_attempt_at <= excluded.last_attempt_at - interval '1 hour'
  returning source into claimed;
  return claimed is not null;
end;
$$;

-- One fetched response is one transaction. No network calls occur under this lock.
-- Serializing these short writes prevents duplicate candidates and orphan jobs when
-- different adapters simultaneously introduce the same previously unknown identity.
create function public.collect_source_batch(
  p_source text, p_items jsonb, p_started_at timestamptz, p_company_id uuid default null
) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  r record;
  saved public.jobs%rowtype;
  existing public.job_sources%rowtype;
  candidates uuid[];
  job_id uuid;
  location_key text;
  salary_compatible boolean;
  salary_empty boolean;
  upserted integer := 0;
  closed integer := 0;
  discovered integer := 0;
  inserted integer;
  ats_source boolean := p_source in ('ashby', 'greenhouse', 'lever', 'recruitee');
begin
  if p_source is null or p_source not in ('ashby', 'greenhouse', 'lever', 'recruitee', 'jobicy', 'wwr', 'remoteok', 'arbeitnow', 'hn') then
    raise exception 'Unsupported collect source';
  end if;
  if p_started_at is null or jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'Invalid collect batch';
  end if;
  if (ats_source and (p_company_id is null or not exists (
    select 1 from public.companies c where c.id = p_company_id and c.ats = p_source
  ))) or (not ats_source and p_company_id is not null) then
    raise exception 'Collect company does not match ATS source';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('rematch.collect', 0));

  for r in select * from jsonb_to_recordset(p_items) as item(
    external_id text, url text, apply_url text, collect_key text, title text, company text,
    location_text text, description text, remote_hint boolean, posted_at timestamptz,
    salary_min numeric, salary_max numeric, salary_currency text, salary_period text,
    company_ats text, company_slug text
  ) loop
    if nullif(r.external_id, '') is null or nullif(r.url, '') is null or
       r.collect_key is null or r.title is null or r.company is null or r.description is null then
      raise exception 'Invalid collect item';
    end if;
    -- Stable source identity wins even if title/company/location text has changed.
    select s.* into existing from public.job_sources s
      where s.source = p_source and s.external_id = r.external_id;
    job_id := existing.job_id;
    if existing.company_id is not null and existing.company_id is distinct from p_company_id then
      raise exception 'Source identity belongs to another ATS company';
    end if;
    -- An older in-flight response cannot undo a newer observation or absence.
    if existing.last_seen_at > p_started_at or existing.stale_at > p_started_at then continue; end if;

    if job_id is null then
      location_key := nullif(lower(regexp_replace(btrim(r.location_text), '\s+', ' ', 'g')), '');
      select array_agg(j.id) into candidates from public.jobs j
      where j.collect_key = r.collect_key
        and not exists (select 1 from public.job_sources s where s.job_id = j.id and s.source = p_source)
        -- Known differing locations are incompatible even with a shared apply URL.
        and (location_key is null or nullif(btrim(j.location_text), '') is null
          or lower(regexp_replace(btrim(j.location_text), '\s+', ' ', 'g')) = location_key)
        and (
          exists (select 1 from public.job_sources s where s.job_id = j.id
            -- Two application URLs can share a generic careers page. At least
            -- one side of the URL match must be an original listing.
            and (s.url = r.url or s.url = nullif(r.apply_url, '') or s.apply_url = r.url))
          or (location_key is not null
            and lower(regexp_replace(btrim(j.location_text), '\s+', ' ', 'g')) = location_key
            and nullif(btrim(r.description), '') is not null
            and regexp_replace(btrim(j.description), '\s+', ' ', 'g') = regexp_replace(btrim(r.description), '\s+', ' ', 'g'))
        );
      -- Multiple matches are ambiguous; keep a separate job rather than guessing.
      if cardinality(candidates) = 1 then job_id := candidates[1]; end if;
    end if;

    if r.company_ats is not null and nullif(r.company_slug, '') is not null then
      insert into public.companies (name, ats, slug, discovered_via)
      values (r.company, r.company_ats, r.company_slug, p_source)
      on conflict (ats, slug) do nothing;
      get diagnostics inserted = row_count;
      discovered := discovered + inserted;
    end if;

    if job_id is null then
      job_id := gen_random_uuid();
      insert into public.jobs (id, dedupe_key, collect_key, title, company, description, location_text,
        salary_min, salary_max, salary_currency, salary_period, posted_at, first_seen_at, company_id)
      values (job_id, r.collect_key || '|' || job_id::text, r.collect_key, r.title, r.company, r.description,
        nullif(btrim(r.location_text), ''), r.salary_min, r.salary_max, r.salary_currency, r.salary_period,
        r.posted_at, p_started_at, p_company_id);
    else
      select j.* into saved from public.jobs j where j.id = job_id;
      salary_empty := saved.salary_min is null and saved.salary_max is null
        and saved.salary_currency is null and saved.salary_period is null;
      salary_compatible := saved.salary_currency is not null and saved.salary_period is not null
        and saved.salary_currency = r.salary_currency and saved.salary_period = r.salary_period;
      update public.jobs j set
        collect_key = coalesce(j.collect_key, r.collect_key),
        location_text = coalesce(j.location_text, nullif(btrim(r.location_text), '')),
        posted_at = coalesce(j.posted_at, r.posted_at), company_id = coalesce(j.company_id, p_company_id),
        salary_min = case when salary_empty or salary_compatible then coalesce(j.salary_min, r.salary_min) else j.salary_min end,
        salary_max = case when salary_empty or salary_compatible then coalesce(j.salary_max, r.salary_max) else j.salary_max end,
        salary_currency = case when salary_empty then r.salary_currency else j.salary_currency end,
        salary_period = case when salary_empty then r.salary_period else j.salary_period end,
        status = 'open'
      where j.id = job_id;
    end if;
    insert into public.job_sources as s (job_id, source, external_id, url, apply_url, remote_hint, company_id, last_seen_at)
    values (job_id, p_source, r.external_id, r.url, r.apply_url, r.remote_hint, p_company_id, p_started_at)
    on conflict (source, external_id) do update set
      url = excluded.url, apply_url = excluded.apply_url, remote_hint = excluded.remote_hint,
      company_id = excluded.company_id, last_seen_at = excluded.last_seen_at, stale_at = null;
    upserted := upserted + 1;
  end loop;

  if ats_source then
    update public.job_sources s set stale_at = p_started_at
      where s.company_id = p_company_id and s.source = p_source and s.last_seen_at < p_started_at
        and (s.stale_at is null or s.stale_at < p_started_at);
    update public.jobs j set status = 'closed'
      where j.status = 'open'
        and exists (select 1 from public.job_sources s where s.job_id = j.id
          and s.company_id = p_company_id and s.source = p_source and s.stale_at is not null)
        and not exists (select 1 from public.job_sources s where s.job_id = j.id
          and (s.source not in ('ashby', 'greenhouse', 'lever', 'recruitee') or s.stale_at is null));
    get diagnostics closed = row_count;
  end if;
  return jsonb_build_object('upserted', upserted, 'closed', closed, 'discovered', discovered);
end;
$$;

revoke all on function public.claim_jobicy_poll() from public, anon, authenticated;
revoke all on function public.collect_source_batch(text, jsonb, timestamptz, uuid) from public, anon, authenticated;
grant execute on function public.claim_jobicy_poll() to service_role;
grant execute on function public.collect_source_batch(text, jsonb, timestamptz, uuid) to service_role;
