-- Sales & Ops reads a 31-day copy of excel_sales / excel_returns. Those views rebuild from raw Cin7
-- data on every query (6-8 s each), so the page would take ~40 s. The copy is refreshed every
-- 10 minutes, 5am-11pm NZ (same pace as the Cin7 sales sync); the page shows when it was refreshed.

create schema if not exists reporting_cache;

create table if not exists reporting_cache.portal_sales_ops_sales (
  order_date date not null, channel text not null, staff text not null, grp text not null,
  model text, gb text, qty numeric not null, rev numeric not null, gp numeric
);
create index if not exists portal_sales_ops_sales_date on reporting_cache.portal_sales_ops_sales(order_date);

create table if not exists reporting_cache.portal_sales_ops_returns (
  activity_date date not null, qty numeric not null, credit numeric not null, record_type text, sales_group text, reason text not null
);
create index if not exists portal_sales_ops_returns_date on reporting_cache.portal_sales_ops_returns(activity_date);

create table if not exists reporting_cache.portal_sales_ops_meta (
  id integer primary key check (id = 1), refreshed_at timestamptz, sales_rows integer, returns_rows integer,
  sales_updated timestamp, returns_updated timestamp, duration_ms integer
);

revoke all on reporting_cache.portal_sales_ops_sales, reporting_cache.portal_sales_ops_returns, reporting_cache.portal_sales_ops_meta from public, anon, authenticated;

create or replace function public.portal_sales_ops_refresh()
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare t0 timestamptz := clock_timestamp(); since date := (now() at time zone 'Pacific/Auckland')::date - 31; ns integer; nr integer; su timestamp; ru timestamp;
begin
  create temp table _s on commit drop as
    select order_date, coalesce(nullif(btrim(sale_channel), ''), 'Unknown') channel,
           coalesce(nullif(btrim(staff), ''), 'Unassigned') staff, coalesce(sales_group, 'Other') grp,
           nullif(btrim("Model"), '') model, nullif(btrim("GB"), '') gb,
           coalesce(quantity, 0) qty, coalesce(line_sales_amount_ex_tax, 0) rev, device_gross_profit gp, cin7_updated_at_nz upd
      from excel_sales where included_in_general_sales and order_date >= since;
  create temp table _r on commit drop as
    select activity_date, coalesce(quantity, 1) qty, coalesce(credit_amount_ex_tax, 0) credit, record_type, sales_group,
           coalesce(nullif(btrim(reported_issue_category), ''), nullif(btrim(reason_hint), ''), 'Not recorded') reason, cin7_updated_at_nz upd
      from excel_returns where activity_date >= since;
  select count(*), max(upd) into ns, su from _s;
  select count(*), max(upd) into nr, ru from _r;
  delete from reporting_cache.portal_sales_ops_sales;
  insert into reporting_cache.portal_sales_ops_sales select order_date, channel, staff, grp, model, gb, qty, rev, gp from _s;
  delete from reporting_cache.portal_sales_ops_returns;
  insert into reporting_cache.portal_sales_ops_returns select activity_date, qty, credit, record_type, sales_group, reason from _r;
  insert into reporting_cache.portal_sales_ops_meta(id, refreshed_at, sales_rows, returns_rows, sales_updated, returns_updated, duration_ms)
  values (1, now(), ns, nr, su, ru, (extract(epoch from clock_timestamp() - t0) * 1000)::integer)
  on conflict (id) do update set refreshed_at = excluded.refreshed_at, sales_rows = excluded.sales_rows, returns_rows = excluded.returns_rows,
    sales_updated = excluded.sales_updated, returns_updated = excluded.returns_updated, duration_ms = excluded.duration_ms;
  return jsonb_build_object('sales', ns, 'returns', nr, 'ms', (extract(epoch from clock_timestamp() - t0) * 1000)::integer);
end $$;
revoke all on function public.portal_sales_ops_refresh() from public, anon, authenticated;
grant execute on function public.portal_sales_ops_refresh() to service_role;

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
    select * from reporting_cache.portal_sales_ops_sales where order_date between d0 and d1
  ), r as materialized (
    select * from reporting_cache.portal_sales_ops_returns where activity_date between d0 and d1
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
        'sales', (select sales_updated from reporting_cache.portal_sales_ops_meta where id = 1),
        'returns', (select returns_updated from reporting_cache.portal_sales_ops_meta where id = 1),
        'cache', (select refreshed_at from reporting_cache.portal_sales_ops_meta where id = 1),
        'stock', (select max(as_of_nzt) from woc_scorecard))
  ) into out;
  return out;
end $$;


select cron.schedule('portal-sales-ops-cache', '*/10 * * * *', $cron$SET statement_timeout = '5min'; DO $quiet$ BEGIN IF extract(hour from clock_timestamp() at time zone 'Pacific/Auckland') between 5 and 22 THEN PERFORM public.portal_sales_ops_refresh(); END IF; END $quiet$;$cron$);
