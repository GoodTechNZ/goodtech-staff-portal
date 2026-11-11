-- Sales & Ops dashboard (managers, on allowlisted terminals only).
--
-- Access, checked server-side by the portal-sales-ops edge function on every request:
--   * signed-in portal session whose staff role is 'manager';
--   * the session's terminal is in portal_config 'dashboard_terminals' (JSON array of terminal ids);
--   * a PIN-unlocked dashboard token that lapses after 5 minutes without use (and on lock).

-- Fraser's phone and MacBook. More terminals are switched on from Admin → Terminals.
insert into public.portal_config(key, value)
values ('dashboard_terminals', '["80cdbf3d-6578-4538-8c3f-331505e44e8f","1eeec859-1ca5-4351-8edf-a44cb8b6838e"]')
on conflict (key) do nothing;

create table if not exists public.portal_dashboard_unlocks (
  token_hash text primary key,
  session_id uuid not null references public.portal_sessions(id),
  terminal_id uuid not null references public.portal_terminals(id),
  staff_id uuid not null references public.staff(id),
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  locked_at timestamptz
);
alter table public.portal_dashboard_unlocks enable row level security;
revoke all on public.portal_dashboard_unlocks from anon, authenticated;
grant select, insert, update, delete on public.portal_dashboard_unlocks to service_role;

create or replace function public.portal_dashboard_allowed(p_terminal uuid)
returns boolean language sql stable set search_path = public, pg_temp as $$
  select coalesce((select value::jsonb ? p_terminal::text from portal_config where key = 'dashboard_terminals'), false);
$$;

create or replace function public.portal_dashboard_set_terminal(p_terminal uuid, p_allow boolean)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare cur jsonb;
begin
  if not exists (select 1 from portal_terminals where id = p_terminal and revoked_at is null) then raise exception 'Terminal not found.'; end if;
  select coalesce(value::jsonb, '[]'::jsonb) into cur from portal_config where key = 'dashboard_terminals' for update;
  cur := coalesce(cur, '[]'::jsonb) - p_terminal::text;
  if p_allow then cur := cur || to_jsonb(p_terminal::text); end if;
  insert into portal_config(key, value) values ('dashboard_terminals', cur::text)
  on conflict (key) do update set value = excluded.value, updated_at = now();
  if not p_allow then update portal_dashboard_unlocks set locked_at = now() where terminal_id = p_terminal and locked_at is null; end if;
  return cur;
end $$;

create or replace function public.portal_dashboard_devices()
returns jsonb language sql stable set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name, 'lastSeen', t.last_seen_at, 'allowed', public.portal_dashboard_allowed(t.id)) order by t.name), '[]'::jsonb)
    from portal_terminals t where t.revoked_at is null;
$$;

-- A new unlock replaces any earlier one for the same session.
create or replace function public.portal_dashboard_unlock(p_session uuid, p_terminal uuid, p_staff uuid)
returns text language plpgsql set search_path = public, pg_temp as $$
declare v_token text := public.portal_new_token();
begin
  update portal_dashboard_unlocks set locked_at = now() where session_id = p_session and locked_at is null;
  insert into portal_dashboard_unlocks(token_hash, session_id, terminal_id, staff_id) values (public.portal_token_hash(v_token), p_session, p_terminal, p_staff);
  delete from portal_dashboard_unlocks where created_at < now() - interval '7 days';
  return v_token;
end $$;

-- Valid (and refreshed) only for the same session and terminal, used within the last 5 minutes.
create or replace function public.portal_dashboard_check(p_token text, p_session uuid, p_terminal uuid)
returns boolean language plpgsql set search_path = public, pg_temp as $$
begin
  update portal_dashboard_unlocks set last_used_at = now()
   where token_hash = public.portal_token_hash(coalesce(p_token, '')) and session_id = p_session and terminal_id = p_terminal
     and locked_at is null and last_used_at > now() - interval '5 minutes';
  return found;
end $$;

create or replace function public.portal_dashboard_lock(p_token text, p_session uuid)
returns void language sql set search_path = public, pg_temp as $$
  update portal_dashboard_unlocks set locked_at = now()
   where locked_at is null and (token_hash = public.portal_token_hash(coalesce(p_token, '')) or session_id = p_session);
$$;

-- The numbers. Periods are NZ calendar days: today, yesterday, last 7 days, last 30 days (incl. today).
create or replace function public.portal_sales_ops(p_period text)
returns jsonb language plpgsql stable set search_path = public, pg_temp as $$
declare today date := (now() at time zone 'Pacific/Auckland')::date; d0 date; d1 date; out jsonb;
begin
  case p_period
    when 'today' then d0 := today; d1 := today;
    when 'yesterday' then d0 := today - 1; d1 := today - 1;
    when '7d' then d0 := today - 6; d1 := today;
    when '30d' then d0 := today - 29; d1 := today;
    else raise exception 'Unknown period.';
  end case;

  with s as materialized (
    select coalesce(nullif(btrim(sale_channel), ''), 'Unknown') channel,
           coalesce(nullif(btrim(staff), ''), 'Unassigned') staff,
           coalesce(sales_group, 'Other') grp,
           nullif(btrim("Model"), '') model, nullif(btrim("GB"), '') gb,
           coalesce(quantity, 0) qty, coalesce(line_sales_amount_ex_tax, 0) rev, device_gross_profit gp
      from excel_sales
     where included_in_general_sales and order_date between d0 and d1
  ), r as materialized (
    select coalesce(quantity, 1) qty, coalesce(credit_amount_ex_tax, 0) credit, record_type, sales_group,
           coalesce(nullif(btrim(reported_issue_category), ''), nullif(btrim(reason_hint), ''), 'Not recorded') reason
      from excel_returns where activity_date between d0 and d1
  ), shipped as materialized (
    select coalesce(nullif(btrim(staff), ''), 'Unassigned') staff, count(*) orders, sum(coalesce(device_count, 0)) devices
      from staff_shipping_completions
     where (completed_at at time zone 'Pacific/Auckland')::date between d0 and d1
     group by 1
  ), tested as materialized (
    select initcap(coalesce(nullif(btrim(record->>'tester'), ''), 'Unknown')) staff, count(distinct serial) devices
      from portal_grading_records
     where linked_record_id is null and record->>'date' ~ '^\d{4}-\d{2}-\d{2}$' and (record->>'date')::date between d0 and d1
     group by 1
  ), dev as (select coalesce(sum(qty), 0) units from s where grp = 'Devices')
  select jsonb_build_object(
    'period', p_period, 'from', d0, 'to', d1, 'generatedAt', now(),
    'sales', (select jsonb_build_object(
        'deviceUnits', coalesce(sum(qty) filter (where grp = 'Devices'), 0),
        'otherUnits', coalesce(sum(qty) filter (where grp <> 'Devices'), 0),
        'revenue', round(coalesce(sum(rev), 0), 2),
        'gp', round(coalesce(sum(gp), 0), 2),
        'gpPct', round(100 * sum(gp) / nullif(sum(rev) filter (where gp is not null), 0), 1),
        'revenueWithoutCost', round(coalesce(sum(rev) filter (where gp is null), 0), 2)) from s),
    'topModels', coalesce((select jsonb_agg(x order by x.units desc, x.revenue desc) from (
        select model || coalesce(' ' || gb, '') model, sum(qty) units, round(sum(rev), 2) revenue, round(sum(gp), 2) gp,
               round(100 * sum(gp) / nullif(sum(rev) filter (where gp is not null), 0), 1) "gpPct"
          from s where grp = 'Devices' and model is not null group by model, gb
         order by sum(qty) desc, sum(rev) desc limit 10) x), '[]'::jsonb),
    'channels', coalesce((select jsonb_agg(x order by x.revenue desc) from (
        select channel name, coalesce(sum(qty) filter (where grp = 'Devices'), 0) units, round(sum(rev), 2) revenue, round(sum(gp), 2) gp,
               round(100 * sum(gp) / nullif(sum(rev) filter (where gp is not null), 0), 1) "gpPct"
          from s group by channel) x), '[]'::jsonb),
    'staff', coalesce((select jsonb_agg(x order by x.revenue desc) from (
        select staff name, coalesce(sum(qty) filter (where grp = 'Devices'), 0) units, round(sum(rev), 2) revenue, round(sum(gp), 2) gp,
               round(100 * sum(gp) / nullif(sum(rev) filter (where gp is not null), 0), 1) "gpPct"
          from s group by staff) x), '[]'::jsonb),
    'returns', (select jsonb_build_object(
        'count', coalesce(sum(qty), 0),
        'credits', coalesce(sum(qty) filter (where record_type = 'Credit item'), 0),
        'creditValue', round(coalesce(sum(credit), 0), 2),
        'deviceReturns', coalesce(sum(qty) filter (where sales_group = 'Devices'), 0),
        'rate', round(100 * coalesce(sum(qty) filter (where sales_group = 'Devices'), 0) / nullif((select units from dev), 0), 1),
        'reasons', coalesce((select jsonb_agg(y order by y.count desc) from (
            select reason, sum(qty) count from r group by reason order by sum(qty) desc limit 5) y), '[]'::jsonb)) from r),
    'shipped', jsonb_build_object(
        'orders', coalesce((select sum(orders) from shipped), 0), 'devices', coalesce((select sum(devices) from shipped), 0),
        'staff', coalesce((select jsonb_agg(jsonb_build_object('name', staff, 'orders', orders, 'devices', devices) order by orders desc) from shipped), '[]'::jsonb)),
    'tested', jsonb_build_object(
        'devices', coalesce((select sum(devices) from tested), 0),
        'staff', coalesce((select jsonb_agg(jsonb_build_object('name', staff, 'devices', devices) order by devices desc) from tested), '[]'::jsonb)),
    'lowStock', coalesce((select jsonb_agg(x) from (
        select model, gb, rfs, total_cover_units "totalCover", sold_7d "sold7d", sold_30d "sold30d", weekly_rate "weeklyRate",
               woc_rfs "wocRfs", woc_total "wocTotal", action
          from woc_scorecard where not coalesce(is_low_mover, false) and weekly_rate >= 2
         order by woc_rfs asc nulls last, weekly_rate desc limit 5) x), '[]'::jsonb),
    'freshness', jsonb_build_object(
        'sales', (select max(cin7_updated_at_nz) from excel_sales),
        'returns', (select max(cin7_updated_at_nz) from excel_returns),
        'stock', (select max(as_of_nzt) from woc_scorecard))
  ) into out;
  return out;
end $$;

do $$
declare f text;
begin
  foreach f in array array['portal_dashboard_allowed(uuid)', 'portal_dashboard_set_terminal(uuid, boolean)', 'portal_dashboard_devices()', 'portal_dashboard_unlock(uuid, uuid, uuid)',
                           'portal_dashboard_check(text, uuid, uuid)', 'portal_dashboard_lock(text, uuid)', 'portal_sales_ops(text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
