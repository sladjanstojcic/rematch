-- Classify a scored batch at write time, after the AI call has finished.
create function public.insert_scored_matches(
  p_subscriber_id uuid, p_prompt text, p_location text, p_prompt_hash text, p_results jsonb
) returns table (job_id uuid, is_match boolean)
language plpgsql security invoker set search_path = '' as $$
declare
  latest_cycle_id uuid;
  latest_closed_at timestamptz;
begin
  -- Same lock order as prompt refresh: subscriber, then cycle. An edit or refresh
  -- during AI work must not allow stale scores to repopulate deleted matches.
  perform 1 from public.subscribers s
  where s.id = p_subscriber_id and s.active
    and s.prompt = p_prompt and s.location = p_location
    and s.prompt_hash = p_prompt_hash and s.constraints is not null
  for update;
  if not found then return; end if;

  -- Ordinal, not created_at or hash, defines the authoritative cycle. Holding
  -- this lock keeps closure from changing between classification and insertion.
  select c.id, c.closed_at into latest_cycle_id, latest_closed_at
  from public.catchup_cycles c where c.subscriber_id = p_subscriber_id
  order by c.ordinal desc limit 1 for update;

  return query
  insert into public.matches as m (subscriber_id, job_id, score, reason, is_match, catchup, suppressed)
  select p_subscriber_id, r.job_id, r.score, r.reason, r.is_match,
    cm.job_id is not null, cm.job_id is not null and latest_closed_at is not null
  from pg_catalog.jsonb_to_recordset(p_results) as r(job_id uuid, score int, reason text, is_match boolean)
  left join public.catchup_members cm on cm.cycle_id = latest_cycle_id and cm.job_id = r.job_id
  on conflict on constraint matches_subscriber_id_job_id_key do nothing
  returning m.job_id, m.is_match;
end;
$$;

revoke all on function public.insert_scored_matches(uuid, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.insert_scored_matches(uuid, text, text, text, jsonb)
  to service_role;
