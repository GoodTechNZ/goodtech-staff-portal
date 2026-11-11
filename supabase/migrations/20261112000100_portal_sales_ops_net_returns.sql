-- Sales & Ops: Sales figures are net of returns.
-- Credited returns (excel_returns 'Credit item', by credit date) are taken off device units, revenue ex GST
-- and GP, overall and by model, channel and staff. Replacements without a credit don't change sales.
-- GP given back = credit less the returned item's cost (current Cin7 average cost; returns carry no cost).
-- Accessories without a cost (non-inventory add-ons) give back the whole credit.
-- The return rate still compares device returns with gross devices sold.

alter table reporting_cache.portal_sales_ops_returns
  add column if not exists channel text, add column if not exists staff text,
  add column if not exists model text, add column if not exists gb text, add column if not exists cost numeric;

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
    select r.activity_date, coalesce(r.quantity, 1) qty, coalesce(r.credit_amount_ex_tax, 0) credit, r.record_type, r.sales_group,
           coalesce(nullif(btrim(r.reported_issue_category), ''), nullif(btrim(r.reason_hint), ''), 'Not recorded') reason, r.cin7_updated_at_nz upd,
           coalesce(nullif(btrim(r.sale_channel), ''), 'Unknown') channel, coalesce(nullif(btrim(r.staff), ''), 'Unassigned') staff,
           nullif(btrim(r."Model"), '') model, nullif(btrim(r."GB"), '') gb,
           -- The returned item goes back into stock at its current average cost (returns carry no cost of their own).
           case when p.average_cost > 0 then round(coalesce(r.quantity, 1) * p.average_cost, 2) end cost
      from excel_returns r left join cin7_products p on p.sku = r.sku
     where r.activity_date >= since;
  select count(*), max(upd) into ns, su from _s;
  select count(*), max(upd) into nr, ru from _r;
  delete from reporting_cache.portal_sales_ops_sales;
  insert into reporting_cache.portal_sales_ops_sales select order_date, channel, staff, grp, model, gb, qty, rev, gp from _s;
  delete from reporting_cache.portal_sales_ops_returns;
  insert into reporting_cache.portal_sales_ops_returns(activity_date, qty, credit, record_type, sales_group, reason, channel, staff, model, gb, cost)
    select activity_date, qty, credit, record_type, sales_group, reason, channel, staff, model, gb, cost from _r;
  insert into reporting_cache.portal_sales_ops_meta(id, refreshed_at, sales_rows, returns_rows, sales_updated, returns_updated, duration_ms)
  values (1, now(), ns, nr, su, ru, (extract(epoch from clock_timestamp() - t0) * 1000)::integer)
  on conflict (id) do update set refreshed_at = excluded.refreshed_at, sales_rows = excluded.sales_rows, returns_rows = excluded.returns_rows,
    sales_updated = excluded.sales_updated, returns_updated = excluded.returns_updated, duration_ms = excluded.duration_ms;
  return jsonb_build_object('sales', ns, 'returns', nr, 'ms', (extract(epoch from clock_timestamp() - t0) * 1000)::integer);
end $$;

create or replace function public.portal_sales_ops(p_period text)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp as $$
declare today date := (now() at time zone 'Pacific/Auckland')::date; d0 date; d1 date; out jsonb;
begin
  case p_period
    when 'today' then d0 := today; d1 := today;
    when 'yesterday' then d0 := today - 1; d1 := today - 1;
    when '7d' then d0 := today - 7; d1 := today - 1;
    when '30d' then d0 := today - 30; d1 := today - 1;
    else raise exception 'Unknown period.';
  end case;

  with g as materialized (
    select channel, staff, grp, model, gb, qty, rev, gp from reporting_cache.portal_sales_ops_sales where order_date between d0 and d1
  ), r as materialized (
    select * from reporting_cache.portal_sales_ops_returns where activity_date between d0 and d1
  ), s as materialized (
    -- Net of returns: credited returns (by credit date) come off units, revenue and GP. GP given back is
    -- the credit less the returned item's cost; the whole credit for accessories without a cost; unknown
    -- for repairs (no cost).
    select channel, staff, grp, model, gb, qty, rev, gp from g
    union all
    select channel, staff, coalesce(sales_group, 'Other'), model, gb, -qty, -credit,
           case when cost is not null then -(credit - cost) when sales_group = 'Accessories' then -credit end
      from r where record_type = 'Credit item'
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
  ), dev as (select coalesce(sum(qty), 0) units from g where grp = 'Devices')
  select jsonb_build_object(
    'period', p_period, 'from', d0, 'to', d1, 'generatedAt', now(),
    'sales', (select jsonb_build_object(
        'deviceUnits', coalesce(sum(qty) filter (where grp = 'Devices'), 0),
        'otherUnits', coalesce(sum(qty) filter (where grp <> 'Devices'), 0),
        'revenue', round(coalesce(sum(rev), 0), 2),
        'gp', round(coalesce(sum(gp), 0), 2),
        'gpPct', round(100 * sum(gp) / nullif(sum(rev) filter (where gp is not null), 0), 1),
        'revenueWithoutCost', round(coalesce(sum(rev) filter (where gp is null), 0), 2),
        'grossDeviceUnits', (select units from dev),
        'grossRevenue', (select round(coalesce(sum(rev), 0), 2) from g),
        'returnedUnits', (select coalesce(sum(qty), 0) from r where record_type = 'Credit item'),
        'returnedDevices', (select coalesce(sum(qty), 0) from r where record_type = 'Credit item' and sales_group = 'Devices'),
        'returnedCredit', (select round(coalesce(sum(credit), 0), 2) from r where record_type = 'Credit item')) from s),
    'topModels', coalesce((select jsonb_agg(x order by x.units desc, x.revenue desc) from (
        select model || coalesce(' ' || gb, '') model, sum(qty) units, round(sum(rev), 2) revenue, round(sum(gp), 2) gp,
               round(100 * sum(gp) / nullif(sum(rev) filter (where gp is not null), 0), 1) "gpPct"
          from s where grp = 'Devices' and model is not null group by model, gb
        having sum(qty) > 0 order by sum(qty) desc, sum(rev) desc limit 10) x), '[]'::jsonb),
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



revoke all on function public.portal_sales_ops(text) from public, anon, authenticated;
grant execute on function public.portal_sales_ops(text) to service_role;
-- (Applied live as a separate step, portal_sales_ops_accessory_returns_gp: the accessory rule above.)
