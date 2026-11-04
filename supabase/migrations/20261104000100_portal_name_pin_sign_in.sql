-- Sign in by picking your name on an enrolled terminal, then a 4-digit PIN. Replaces badge scanning.
-- First use: a person with no PIN yet sets one, and managers see a "PIN set" flag that day so they
-- can confirm it was really them.

-- Active staff for the name picker on an enrolled terminal.
create or replace function public.portal_staff_list(p_terminal_token text)
returns jsonb language plpgsql volatile set search_path = '' as $$
begin
  perform public.portal_terminal(p_terminal_token);
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', display_name, 'hasPin', pin_hash is not null) order by display_name)
                     from public.staff where active), '[]'::jsonb);
end $$;

create or replace function public.portal_sign_in_staff(p_terminal_token text, p_staff uuid, p_pin text, p_new_pin text)
returns jsonb language plpgsql volatile set search_path = '' as $$
declare v_terminal uuid; s public.staff; v_token text; v_session uuid; v_problem text; v_check jsonb; v_first boolean := false;
begin
  v_terminal := public.portal_terminal(p_terminal_token);
  select * into s from public.staff where id = p_staff for update;
  if not found or not s.active then raise exception 'Choose your name.'; end if;
  if s.pin_hash is null then
    v_problem := public.portal_pin_problem(p_new_pin);
    if v_problem is not null then raise exception '%', v_problem; end if;
    update public.staff set pin_hash = extensions.crypt(p_new_pin, extensions.gen_salt('bf', 8)), pin_set_at = now(),
      failed_pin_attempts = 0, locked_until = null, updated_at = now() where id = s.id;
    perform public.portal_log(s.id, null, v_terminal, 'auth', 'pin_set', null, 'ok', '{}');
    v_first := true;
  else
    v_check := public.portal_pin_ok(s.id, p_pin, v_terminal, 'sign_in');
    if not (v_check->>'ok')::boolean then return v_check; end if;
  end if;
  -- One live session per person: signing in elsewhere ends the old one.
  update public.portal_sessions set ended_at = now(), end_reason = 'replaced' where staff_id = s.id and ended_at is null;
  v_token := public.portal_new_token();
  insert into public.portal_sessions(token_hash, staff_id, terminal_id) values (public.portal_token_hash(v_token), s.id, v_terminal) returning id into v_session;
  perform public.portal_log(s.id, v_session, v_terminal, 'auth', 'sign_in', null, 'ok', jsonb_build_object('first_use', v_first));
  return jsonb_build_object('ok', true, 'sessionToken', v_token, 'idleSeconds', 600,
    'staff', (select jsonb_build_object('id', id, 'name', display_name, 'role', role) from public.staff where id = s.id));
end $$;

revoke all on function public.portal_staff_list(text) from public, anon, authenticated;
revoke all on function public.portal_sign_in_staff(text,uuid,text,text) from public, anon, authenticated;
grant execute on function public.portal_staff_list(text) to service_role;
grant execute on function public.portal_sign_in_staff(text,uuid,text,text) to service_role;

-- Badge sign-in is retired.
drop function if exists public.portal_badge(text, text);
drop function if exists public.portal_sign_in(text, text, text, text, uuid);
update public.staff set badge_code = null, badge_registered_at = null where badge_code is not null;
comment on table public.staff is 'GoodTech staff roster for the staff portal. display_name is the name written to Grading, Shipping and Sales records. former_names keeps earlier names (Crystal was Wei, Li was Liwei). Staff pick their name on an enrolled terminal and enter a 4-digit PIN, set on first use; pin_hash is bcrypt.';

-- Daily flag: first-time PIN set replaces badge registered.
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
    count(*) filter (where module='auth' and action in ('badge_registered','pin_set')) pin_set,
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
      union all select jsonb_build_object('code','pin_set','severity','medium','message','Set their PIN today. Confirm it was really them.') where pin_set > 0
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
where sign_ins > 0 or pin_failures > 0 or pin_set > 0 or p_staff is not null;
$$;
