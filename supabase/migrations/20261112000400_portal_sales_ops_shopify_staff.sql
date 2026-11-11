-- Sales & Ops "Staff sales": lines with no salesperson are labelled by where they came from.
--   Sales: Shopify-sourced (website, Reebelo and Trade Me orders all arrive via Shopify) -> 'Shopify';
--   otherwise the Cin7 sales rep role (In-Store Sales, Replacement, Repairs, Warranty); else 'Unassigned'
--   (shown as "No salesperson").
--   Returns carry no source field, so blank-staff returns on Website/Reebelo/Trade Me -> 'Shopify'.

create or replace function public.portal_sales_ops_refresh()
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare t0 timestamptz := clock_timestamp(); since date := (now() at time zone 'Pacific/Auckland')::date - 31; ns integer; nr integer; su timestamp; ru timestamp;
begin
  create temp table _s on commit drop as
    select order_date, coalesce(nullif(btrim(sale_channel), ''), 'Unknown') channel,
           coalesce(nullif(btrim(staff), ''),
             case when source_channel_raw = 'Shopify' then 'Shopify' end,
             nullif(btrim(sales_representative_raw), ''), 'Unassigned') staff, coalesce(sales_group, 'Other') grp,
           nullif(btrim("Model"), '') model, nullif(btrim("GB"), '') gb,
           coalesce(quantity, 0) qty, coalesce(line_sales_amount_ex_tax, 0) rev, device_gross_profit gp, cin7_updated_at_nz upd
      from excel_sales where included_in_general_sales and order_date >= since;
  create temp table _r on commit drop as
    select r.activity_date, coalesce(r.quantity, 1) qty, coalesce(r.credit_amount_ex_tax, 0) credit, r.record_type, r.sales_group,
           coalesce(nullif(btrim(r.reported_issue_category), ''), nullif(btrim(r.reason_hint), ''), 'Not recorded') reason, r.cin7_updated_at_nz upd,
           coalesce(nullif(btrim(r.sale_channel), ''), 'Unknown') channel, coalesce(nullif(btrim(r.staff), ''),
             case when r.sale_channel in ('Website', 'Reebelo', 'Trade Me') then 'Shopify' end, 'Unassigned') staff,
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

select public.portal_sales_ops_refresh();
