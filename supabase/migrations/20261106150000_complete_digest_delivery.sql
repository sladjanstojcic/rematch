alter table public.subscribers add column last_digest_on date;

-- SMTP has already succeeded. All delivery bookkeeping commits or rolls back together.
create function public.complete_digest_delivery(
  p_subscriber_id uuid, p_match_ids uuid[], p_today date, p_cycle_id uuid default null
) returns void
language plpgsql security invoker set search_path = '' as $$
declare
  last_day date;
  latest_cycle_id uuid;
  latest_closed_at timestamptz;
  sent_count int;
begin
  if p_today is null or coalesce(cardinality(p_match_ids), 0) = 0 then
    raise exception 'Invalid digest delivery';
  end if;

  -- Match insert_scored_matches: subscriber first, newest cycle second.
  select s.last_digest_on into last_day from public.subscribers s
  where s.id = p_subscriber_id for update;
  if not found or last_day = p_today then
    raise exception 'Digest subscriber unavailable or already delivered';
  end if;
  select c.id, c.closed_at into latest_cycle_id, latest_closed_at
  from public.catchup_cycles c where c.subscriber_id = p_subscriber_id
  order by c.ordinal desc limit 1 for update;

  if p_cycle_id is not null and
    (p_cycle_id is distinct from latest_cycle_id or latest_closed_at is not null) then
    raise exception 'Digest cycle changed';
  end if;

  update public.matches m set emailed_at = now()
  where m.subscriber_id = p_subscriber_id and m.id = any(p_match_ids)
    and m.emailed_at is null and not m.suppressed;
  get diagnostics sent_count = row_count;
  -- A refresh may have replaced the matches while SMTP was in flight. Never
  -- silently commit partial bookkeeping, nor mark another subscriber's rows.
  if sent_count <> cardinality(p_match_ids) then
    raise exception 'Digest matches changed';
  end if;

  if p_cycle_id is not null then
    update public.catchup_cycles set closed_at = now() where id = p_cycle_id;
    update public.matches m set suppressed = true
    where m.subscriber_id = p_subscriber_id and m.emailed_at is null
      and exists (select 1 from public.catchup_members cm
        where cm.cycle_id = p_cycle_id and cm.job_id = m.job_id);
  end if;

  -- The caller's configured-timezone date is the only calendar-day authority.
  update public.subscribers set last_digest_on = p_today where id = p_subscriber_id;
end;
$$;

revoke all on function public.complete_digest_delivery(uuid, uuid[], date, uuid)
  from public, anon, authenticated;
grant execute on function public.complete_digest_delivery(uuid, uuid[], date, uuid)
  to service_role;
