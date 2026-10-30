-- Daily per-person summaries and review flags for the staff portal, computed from
-- portal_activity (NZ calendar day). portal_daily_summary() is live; the nightly job stores
-- a copy in portal_daily_summaries so the record survives later log changes.

create table if not exists public.portal_daily_summaries (
  day date not null,
  staff_id uuid not null references public.staff(id),
  summary jsonb not null,
  flags jsonb not null default '[]'::jsonb,
  generated_at timestamptz not null default now(),
  primary key (day, staff_id)
);
alter table public.portal_daily_summaries enable row level security;
revoke all on public.portal_daily_summaries from anon, authenticated;
grant select, insert, update on public.portal_daily_summaries to service_role;

create or replace function public.portal_daily_summary(p_day date, p_staff uuid default null)
returns jsonb language sql stable set search_path = '' as $$
with bounds as (
  select (p_day::timestamp at time zone 'Pacific/Auckland') t0, ((p_day + 1)::timestamp at time zone 'Pacific/Auckland') t1
), act as (
  -- prev_save_at: the same person's previous grading save, for spotting very fast grading.
  select a.*, lag(a.at) over (partition by a.staff_id, (a.module = 'grading' and a.action = 'save' and a.outcome in ('ok','linked')) order by a.at) prev_save_at
    from public.portal_activity a, bounds b
   where a.at >= b.t0 and a.at < b.t1 and a.staff_id is not null and (p_staff is null or a.staff_id = p_staff)
), per as (
  select s.id staff_id, s.display_name,
    count(*) filter (where module='auth' and action='sign_in') sign_ins,
    count(*) filter (where module='auth' and action='sign_out' and ref='idle') idle_sign_outs,
    count(*) filter (where module='auth' and action='sign_out' and ref='completed') completed_sign_outs,
    min(at) first_at, max(at) last_at,
    count(distinct ref) filter (where module='grading' and action='save' and outcome in ('ok','linked')) devices_graded,
    count(*) filter (where module='grading' and action='save' and outcome='linked') grading_linked,
    count(*) filter (where module='grading' and action='save' and outcome='ok' and (details->>'update')::boolean) regrades,
    count(*) filter (where module='grading' and action='save' and outcome in ('ok','linked') and details->>'grade'='1') grade_1,
    count(*) filter (where module='grading' and action='save' and outcome in ('ok','linked') and details->>'grade'='2') grade_2,
    count(*) filter (where module='grading' and action='save' and outcome in ('ok','linked') and details->>'grade'='3') grade_3,
    count(*) filter (where module='grading' and action='save' and outcome='ok' and details->>'destination' in ('Repairs','Locked')) to_repairs_or_locked,
    count(*) filter (where module='grading' and action='save' and outcome in ('ok','linked') and prev_save_at is not null and at - prev_save_at < interval '30 seconds') fast_saves,
    count(*) filter (where module='shipping' and action in ('ship','pickup_ready','collect') and outcome='ok') orders_shipped,
    count(*) filter (where module='shipping' and action in ('scan','override') and outcome='ok') devices_verified,
    count(*) filter (where module='shipping' and action='override' and outcome='ok') shipping_overrides,
    count(*) filter (where module='shipping' and action in ('scan','override') and outcome='error') scan_errors,
    count(*) filter (where module='sales' and action='create' and outcome='ok') sales_started,
    count(*) filter (where module='sales' and action='ship' and outcome='ok') sales_completed,
    coalesce(sum((details->>'total')::numeric) filter (where module='sales' and action='ship' and outcome='ok'), 0) sales_total,
    count(*) filter (where module='sales' and action='void' and outcome='ok') sales_voided,
    coalesce(sum((details->>'discountedLines')::int) filter (where module='sales' and action='create' and outcome='ok'), 0) discounted_lines,
    count(*) filter (where outcome='error') errors,
    count(*) filter (where module='auth' and action in ('pin_failed','pin_locked')) pin_failures,
    count(*) filter (where module='auth' and action='pin_locked') pin_lockouts,
    count(*) filter (where module='auth' and action='badge_registered') badge_registered,
    count(*) filter (where outcome='denied' and module<>'auth') denied
  from public.staff s
  left join act a on a.staff_id = s.id
  where p_staff is null or s.id = p_staff
  group by s.id, s.display_name
), conflicts as (
  select q.owner_id, count(*) n
    from public.portal_grading_outbox q, bounds b
   where q.created_at >= b.t0 and q.created_at < b.t1 and q.status = 'conflict'
   group by q.owner_id
), summary_rows as (
  select per.*, coalesce(c.n, 0) grading_conflicts
    from per left join conflicts c on c.owner_id = per.staff_id::text
)
select coalesce(jsonb_agg(jsonb_build_object(
  'staffId', staff_id, 'name', display_name,
  'summary', jsonb_build_object(
    'signIns', sign_ins, 'idleSignOuts', idle_sign_outs, 'completedSignOuts', completed_sign_outs,
    'firstAt', first_at, 'lastAt', last_at,
    'grading', jsonb_build_object('devices', devices_graded, 'linked', grading_linked, 'regrades', regrades,
       'grades', jsonb_build_object('1', grade_1, '2', grade_2, '3', grade_3), 'toRepairsOrLocked', to_repairs_or_locked,
       'conflicts', grading_conflicts),
    'shipping', jsonb_build_object('orders', orders_shipped, 'devicesVerified', devices_verified, 'overrides', shipping_overrides, 'scanErrors', scan_errors),
    'sales', jsonb_build_object('started', sales_started, 'completed', sales_completed, 'total', sales_total, 'voided', sales_voided, 'discountedLines', discounted_lines),
    'errors', errors, 'pinFailures', pin_failures),
  'flags', (select coalesce(jsonb_agg(f), '[]'::jsonb) from (
      select jsonb_build_object('code','pin_lockout','severity','high','message','PIN locked after repeated wrong attempts ('||pin_lockouts||')') f where pin_lockouts > 0
      union all select jsonb_build_object('code','pin_failures','severity','medium','message',pin_failures||' wrong PIN attempts') where pin_failures >= 3 and pin_lockouts = 0
      union all select jsonb_build_object('code','badge_registered','severity','medium','message','Registered a badge today. Confirm it is their own badge.') where badge_registered > 0
      union all select jsonb_build_object('code','shipping_override','severity','high','message',shipping_overrides||' manual IMEI override'||case when shipping_overrides=1 then '' else 's' end||' while shipping') where shipping_overrides > 0
      union all select jsonb_build_object('code','scan_errors','severity','medium','message',scan_errors||' shipping scan errors (wrong or unknown device)') where scan_errors >= 3
      union all select jsonb_build_object('code','fast_grading','severity','medium','message',fast_saves||' devices graded less than 30 seconds after the previous one') where fast_saves >= 3
      union all select jsonb_build_object('code','regrade','severity','low','message',regrades||' existing grading record'||case when regrades=1 then '' else 's' end||' changed') where regrades > 0
      union all select jsonb_build_object('code','grading_conflict','severity','medium','message',grading_conflicts||' grading save'||case when grading_conflicts=1 then '' else 's' end||' in conflict with the sheet') where grading_conflicts > 0
      union all select jsonb_build_object('code','sales_void','severity','medium','message',sales_voided||' sale'||case when sales_voided=1 then '' else 's' end||' voided') where sales_voided > 0
      union all select jsonb_build_object('code','discount','severity','low','message',discounted_lines||' sale line'||case when discounted_lines=1 then '' else 's' end||' below catalogue price') where discounted_lines > 0
      union all select jsonb_build_object('code','errors','severity','low','message',errors||' failed actions') where errors >= 5
  ) x)
) order by display_name), '[]'::jsonb)
from summary_rows
where sign_ins > 0 or pin_failures > 0 or badge_registered > 0 or p_staff is not null;
$$;

create or replace function public.portal_daily_rollup(p_day date default ((now() at time zone 'Pacific/Auckland')::date))
returns integer language plpgsql volatile set search_path = '' as $$
declare n integer;
begin
  insert into public.portal_daily_summaries(day, staff_id, summary, flags, generated_at)
  select p_day, (x->>'staffId')::uuid, x->'summary', x->'flags', now()
    from jsonb_array_elements(public.portal_daily_summary(p_day, null)) x
  on conflict (day, staff_id) do update set summary = excluded.summary, flags = excluded.flags, generated_at = excluded.generated_at;
  get diagnostics n = row_count;
  return n;
end $$;

-- Operational health for the dashboard: grading outbox and sheet worker.
create or replace function public.portal_health()
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'grading', jsonb_build_object(
      'pending', (select count(*) from public.portal_grading_outbox where status in ('pending','working')),
      'oldestPendingAt', (select min(created_at) from public.portal_grading_outbox where status in ('pending','working')),
      'conflicts', (select count(*) from public.portal_grading_outbox where status = 'conflict'),
      'linkedToday', (select count(*) from public.portal_grading_outbox where status = 'linked' and synced_at >= (((now() at time zone 'Pacific/Auckland')::date)::timestamp at time zone 'Pacific/Auckland')),
      'workerAt', (select value->>'at' from public.portal_grading_health where key = 'worker'),
      'importAt', (select value->>'at' from public.portal_grading_health where key = 'import')),
    'sessions', jsonb_build_object(
      'active', (select count(*) from public.portal_sessions where ended_at is null and last_seen_at > now() - interval '10 minutes')));
$$;

do $$
declare f text;
begin
  foreach f in array array['portal_daily_summary(date,uuid)','portal_daily_rollup(date)','portal_health()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

-- 23:58 NZ time, every day (cron runs in UTC; schedule both NZST and NZDT offsets, the function is idempotent).
select cron.schedule('portal-daily-rollup-nzdt', '58 10 * * *', $$select public.portal_daily_rollup(((now() at time zone 'Pacific/Auckland')::date))$$);
select cron.schedule('portal-daily-rollup-nzst', '58 11 * * *', $$select public.portal_daily_rollup(((now() at time zone 'Pacific/Auckland') - interval '1 hour')::date)$$);
