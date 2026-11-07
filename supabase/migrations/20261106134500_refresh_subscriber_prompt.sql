-- AI parsing happens before this call. All refresh effects commit or roll back together.
create function public.refresh_subscriber_prompt(
  p_subscriber_id uuid, p_prompt text, p_location text, p_prompt_hash text,
  p_constraints jsonb, p_cutoff timestamptz
) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare
  refreshed_id uuid;
  cycle_id uuid;
begin
  if jsonb_typeof(p_constraints) is distinct from 'object'
    or nullif(p_prompt_hash, '') is null or p_cutoff is null then
    raise exception 'Invalid subscriber prompt refresh';
  end if;

  -- UPDATE serializes refreshes for this subscriber and rechecks the predicates
  -- after a concurrent write. Stale AI results cannot overwrite edited input.
  update public.subscribers s set constraints = p_constraints, prompt_hash = p_prompt_hash
  where s.id = p_subscriber_id and s.active
    and s.prompt = p_prompt and s.location = p_location
    and s.prompt_hash is distinct from p_prompt_hash
  returning s.id into refreshed_id;
  if refreshed_id is null then return null; end if;

  delete from public.matches m where m.subscriber_id = refreshed_id and m.emailed_at is null;

  -- Each successful refresh is a new cycle, even if an older cycle used this hash.
  insert into public.catchup_cycles (subscriber_id, prompt_hash)
  values (refreshed_id, p_prompt_hash) returning id into cycle_id;

  -- No enrichment/match join: retries must retain jobs that are not yet processed.
  -- The cutoff is supplied by the same helper used by freshnessFilter in the worker.
  insert into public.catchup_members (cycle_id, job_id)
  select cycle_id, j.id from public.jobs j
  where j.status = 'open' and coalesce(j.posted_at, j.first_seen_at) >= p_cutoff;

  return cycle_id;
end;
$$;

revoke all on function public.refresh_subscriber_prompt(uuid, text, text, text, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function public.refresh_subscriber_prompt(uuid, text, text, text, jsonb, timestamptz)
  to service_role;
