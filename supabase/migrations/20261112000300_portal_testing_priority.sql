-- Testing priority on the Grading tab (from the "Daily testing priority" routine).
-- Ranks devices in received HYLA SOs that still need testing against sales velocity and Ready For
-- Sale stock, so testers work on the shortest-stocked, fastest-selling models first.
--
-- Untested devices: ASNs rows with no grade whose SO has a Delivered date in Shipment Check
--   (asn_ops_rows + asn_shipment_check, synced from ASNs DB every 10 minutes). Model/GB from the
--   ASNs Model/GB lookups (portal_grading_directory), falling back to the item description.
-- Demand (the routine's SQL, ~50 s, so cached hourly): sold 30/90 days per model + GB from
--   excel_sales (phones, tablets, watches; Bargain Bin excluded) and Cin7 Ready For Sale stock.
-- Rules (unchanged from the routine):
--   daily velocity = max(sold 30d / 30, sold 90d / 90 × 0.8); days cover = RFS ÷ velocity.
--   Urgent < 7 days cover, High < 14, Medium < 30, else Low. Fewer than 4 sold in 30 days drops a tier.
--   Test now = units needed to reach 21 days of cover, capped at the number awaiting test.

create schema if not exists reporting_cache;
create table if not exists reporting_cache.portal_testing_demand (
  model text, gb text, u30 numeric not null, u90 numeric not null, rfs numeric not null
);
create table if not exists reporting_cache.portal_testing_demand_meta (
  id integer primary key check (id = 1), refreshed_at timestamptz, stock_as_of text, rows integer, duration_ms integer
);
revoke all on reporting_cache.portal_testing_demand, reporting_cache.portal_testing_demand_meta from public, anon, authenticated;

create or replace function public.portal_testing_demand_refresh()
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare t0 timestamptz := clock_timestamp(); n integer; asof text;
begin
  create temp table _d on commit drop as
  with s as (
    select "Model" m, "GB" gb,
           sum(quantity) filter (where order_date > current_date - 30) u30,
           sum(quantity) u90
      from excel_sales
     where transaction_type = 'SALE' and "Category" in ('Unlocked Mobile Phones', 'Tablet Computers', 'Watches')
       and order_date > current_date - 90 and coalesce(additional_attribute_9, '') not ilike '%bargain%' and "Model" is not null
     group by 1, 2
  ), a as (
    select coalesce(additional_attribute_2, trim(substring(short_description from '^(.*?)\d+(?:GB|TB|mm)'))) m,
           coalesce(additional_attribute_3, substring(short_description from '(\d+(?:GB|TB|mm))')) gb, sum(available) rfs
      from products_with_availability
     where location = 'Ready For Sale' and available > 0
       and category in ('Unlocked Mobile Phones', 'Tablet Computers', 'Watches')
       and coalesce(additional_attribute_9, '') not ilike '%bargain%'
     group by 1, 2
  )
  select coalesce(s.m, a.m) model, coalesce(s.gb, a.gb) gb, coalesce(u30, 0) u30, coalesce(u90, 0) u90, coalesce(rfs, 0) rfs
    from s full join a on s.m = a.m and s.gb = a.gb;
  select max(availability_updated_at)::text into asof from products_with_availability;
  delete from reporting_cache.portal_testing_demand;
  insert into reporting_cache.portal_testing_demand select * from _d;
  get diagnostics n = row_count;
  insert into reporting_cache.portal_testing_demand_meta(id, refreshed_at, stock_as_of, rows, duration_ms)
  values (1, now(), asof, n, (extract(epoch from clock_timestamp() - t0) * 1000)::integer)
  on conflict (id) do update set refreshed_at = excluded.refreshed_at, stock_as_of = excluded.stock_as_of, rows = excluded.rows, duration_ms = excluded.duration_ms;
  return jsonb_build_object('rows', n, 'ms', (extract(epoch from clock_timestamp() - t0) * 1000)::integer);
end $$;

create or replace function public.portal_testing_priority()
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  with dev as (
    select a.serial, a.order_number so, s.delivered, coalesce(d.metadata->>'supplier', '') descr,
           nullif(nullif(btrim(d.metadata->>'model'), ''), '#N/A') m0, btrim(coalesce(d.metadata->>'capacity', '')) g0
      from asn_ops_rows a
      join asn_shipment_check s on s.order_number = a.order_number and coalesce(s.delivered, '') <> ''
      left join portal_grading_directory d on d.serial = a.serial
     where a.grade in ('', '-', '#N/A')
  ), named as (
    select *, coalesce(m0, nullif(split_part(descr, '.', 2), ''), descr) m1 from dev
  ), norm as (
    select serial, so,
           case m1 when 'Galaxy S24 Plus 5G' then 'Galaxy S24+' when 'Galaxy S25 Ultra 5G' then 'Galaxy S25 Ultra'
                   when 'Galaxy S25 5G' then 'Galaxy S25' when 'Galaxy S23 Fan Edition 5G' then 'Galaxy S23 FE'
                   when 'Pixel 8 Pro 5G' then 'Pixel 8 Pro' when 'Watch Series 9' then 'Apple Watch Series 9' else m1 end model,
           case when m1 ilike '%watch%' then coalesce(substring(descr from '(\d+mm)'), g0)
                when g0 ~ '(GB|TB|mm)' then g0
                else coalesce(substring(descr from '\.(\d+mm)\.'), substring(descr from '\.(\d+(?:GB|TB))\M'), '?') end gb
      from named
  ), grp as (
    select model, gb, sum(c) n, jsonb_object_agg(so, c) sos
      from (select model, gb, so, count(*) c from norm group by 1, 2, 3) x
     group by model, gb
  ), scored as (
    select g.*, coalesce(d.u30, 0) u30, coalesce(d.u90, 0) u90, coalesce(d.rfs, 0) rfs,
           greatest(coalesce(d.u30, 0) / 30.0, coalesce(d.u90, 0) / 90.0 * 0.8) daily
      from grp g left join reporting_cache.portal_testing_demand d on d.model = g.model and d.gb = g.gb
  ), tiered as (
    select *, case when daily > 0 then rfs / daily end cover,
           greatest(0, round(daily * 21 - rfs)) need,
           case when daily = 0 then 4 when rfs / daily < 7 then 1 when rfs / daily < 14 then 2 when rfs / daily < 30 then 3 else 4 end t0
      from scored
  ), final as (
    select *, case when u30 < 4 and t0 < 4 then t0 + 1 else t0 end tier from tiered
  )
  select jsonb_build_object(
    'total', (select count(*) from norm),
    'bySo', coalesce((select jsonb_agg(x order by x.so) from (select so, count(*) n, max(delivered) delivered from dev group by so) x), '[]'::jsonb),
    'tiers', (select jsonb_build_object(
        'urgent', coalesce(sum(n) filter (where tier = 1), 0), 'high', coalesce(sum(n) filter (where tier = 2), 0),
        'medium', coalesce(sum(n) filter (where tier = 3), 0), 'low', coalesce(sum(n) filter (where tier = 4), 0),
        'urgentModels', count(distinct model) filter (where tier = 1)) from final),
    'rows', coalesce((select jsonb_agg(jsonb_build_object(
        'tier', tier, 'model', model, 'gb', gb, 'untested', n, 'sold30', u30, 'sold90', u90, 'rfs', rfs,
        'cover', round(cover::numeric, 1), 'testNow', case when tier < 4 then least(n, need) else 0 end, 'sos', sos)
        order by tier, u30 desc, cover nulls last, model, gb) from final), '[]'::jsonb),
    'demandAt', (select refreshed_at from reporting_cache.portal_testing_demand_meta where id = 1),
    'stockAsOf', (select stock_as_of from reporting_cache.portal_testing_demand_meta where id = 1),
    'asnSyncedAt', (select max(synced_at) from asn_ops_sync_log));
$$;

revoke all on function public.portal_testing_demand_refresh() from public, anon, authenticated;
revoke all on function public.portal_testing_priority() from public, anon, authenticated;
grant execute on function public.portal_testing_demand_refresh() to service_role;
grant execute on function public.portal_testing_priority() to service_role;

-- Hourly, 5am-10pm NZ.
select cron.schedule('portal-testing-demand', '20 * * * *', $cron$SET statement_timeout = '5min'; DO $quiet$ BEGIN IF extract(hour from clock_timestamp() at time zone 'Pacific/Auckland') between 5 and 22 THEN PERFORM public.portal_testing_demand_refresh(); END IF; END $quiet$;$cron$);
