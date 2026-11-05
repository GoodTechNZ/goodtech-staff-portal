-- High alert list carries is_pickup so the Dashboard can mark pick-up orders.
create or replace function public.portal_ops_dashboard()
returns jsonb language sql stable set search_path = public, pg_temp as $$
with open_orders as materialized (
  select o.document_id, o.document_number, o.reference, o.party, o.document_date, o.operational_stage, o.picking_status, o.packing_status,
         o.shipping_status, o.invoice_status, o.amount,
         exists(select 1 from staff_pickup_orders p where p.cin7_sale_id::text = o.document_id)
           or coalesce(s.detail->>'Carrier', s.summary->>'Carrier', '') ~* '(pick.?up|collect|1a Elgin)' is_pickup,
         public.portal_business_days_since(o.document_date) business_days
    from open_cin7_sales_orders o join cin7_sales_raw s on s.cin7_sale_id = o.document_id
   where o.operational_stage not in ('QUOTE', 'DRAFT ORDER')
     and coalesce(s.status, '') not in ('VOIDED', 'CANCELLED', 'COMPLETED')
), pickups as materialized (
  select p.cin7_sale_id::text document_id, s.order_number document_number, p.order_name reference,
         coalesce(s.detail->>'Customer', s.summary->>'Customer') party, p.ready_at::date document_date
    from staff_pickup_orders p join cin7_sales_raw s on s.cin7_sale_id = p.cin7_sale_id::text
    left join shopify_orders sh on sh.order_id::text = p.shopify_order_id
   where p.ready_status = 'ready' and p.collected_at is null and p.collect_status <> 'collected'
     and coalesce(s.status, '') not in ('VOIDED', 'CANCELLED', 'COMPLETED')
     and coalesce(s.detail->>'CombinedShippingStatus', s.summary->>'CombinedShippingStatus', '') <> 'SHIPPED'
     and coalesce(sh.fulfillment_status, '') <> 'FULFILLED' and sh.cancelled_at is null
), queues as materialized (
  select 'new' q, * from open_orders where coalesce(shipping_status, '') <> 'SHIPPED' and picking_status = 'NOT PICKED'
  union all select 'picked', * from open_orders where coalesce(shipping_status, '') <> 'SHIPPED' and picking_status = 'PICKED' and coalesce(packing_status, '') <> 'PACKED'
  union all select 'packed', * from open_orders where coalesce(shipping_status, '') <> 'SHIPPED' and packing_status = 'PACKED' and not is_pickup
  union all select 'alert', * from open_orders where business_days > 1
), stock as materialized (
  select a.location, a.product_id, max(a.sku) sku, max(a.name) name, sum(a.on_hand) qty
    from cin7_product_availability a join cin7_products p using (product_id)
   where a.on_hand > 0 and a.location in ('Repairs', 'Locked Devices')
     and p.category in ('Unlocked Mobile Phones', 'Watches', 'Tablet Computers', 'Tablets', 'Laptop', 'Laptops', 'Computers')
   group by a.location, a.product_id
), stock_aged as materialized (
  select s.*, g.stock_age_days, g.age_covered_quantity, g.oldest_stock_age_days
    from stock s left join cin7_stock_age g on g.product_id = s.product_id and g.location = s.location
)
select jsonb_build_object(
  'generatedAt', now(),
  'orders', jsonb_build_object(
    'new', (select jsonb_build_object('count', count(*), 'oldest', min(document_date)) from queues where q = 'new'),
    'picked', (select jsonb_build_object('count', count(*), 'oldest', min(document_date)) from queues where q = 'picked'),
    'packed', (select jsonb_build_object('count', count(*), 'oldest', min(document_date)) from queues where q = 'packed'),
    'pickup', (select jsonb_build_object('count', count(*), 'oldest', min(document_date)) from pickups),
    'alert', (select jsonb_build_object('count', count(*), 'oldest', min(document_date)) from queues where q = 'alert'),
    'lists', jsonb_build_object(
      'new', (select coalesce(jsonb_agg(x), '[]') from (select document_number, reference, party, document_date, business_days, is_pickup from queues where q = 'new' order by document_date, document_number limit 25) x),
      'picked', (select coalesce(jsonb_agg(x), '[]') from (select document_number, reference, party, document_date, business_days, is_pickup from queues where q = 'picked' order by document_date, document_number limit 25) x),
      'packed', (select coalesce(jsonb_agg(x), '[]') from (select document_number, reference, party, document_date, business_days from queues where q = 'packed' order by document_date, document_number limit 25) x),
      'pickup', (select coalesce(jsonb_agg(x), '[]') from (select document_number, reference, party, document_date from pickups order by document_date limit 25) x),
      'alert', (select coalesce(jsonb_agg(x), '[]') from (select document_number, reference, party, document_date, business_days, operational_stage stage, is_pickup from queues where q = 'alert' order by document_date, document_number limit 25) x))),
  'returns', (select jsonb_build_object('untriaged', count(*) filter (where coalesce(workflow_status, 'Untriaged') = 'Untriaged'), 'total', count(*), 'updatedAt', max(source_synced_at))
                from service_requests where coalesce(request_type, '') <> 'Trade-in' and coalesce(jotform_status, 'ACTIVE') not in ('DELETED', 'ARCHIVED')),
  'stock', (select jsonb_object_agg(k, v) from (
      select case location when 'Locked Devices' then 'locked' else 'repairs' end k,
             jsonb_build_object('devices', sum(qty), 'products', count(*),
               -- Quantity-weighted stock age over devices with receipt coverage. Stock age, not time in the location.
               'averageAgeDays', round(sum(stock_age_days * age_covered_quantity) filter (where stock_age_days is not null) / nullif(sum(age_covered_quantity) filter (where stock_age_days is not null), 0)),
               'oldestAgeDays', max(oldest_stock_age_days),
               'items', (select coalesce(jsonb_agg(x), '[]') from (select sku, name, qty, stock_age_days age_days from stock_aged s2 where s2.location = s.location order by stock_age_days desc nulls last, sku limit 25) x)) v
        from stock_aged s group by location) t),
  'freshness', jsonb_build_object('orders', (select max(list_fetched_at) from cin7_sales_raw), 'stock', (select max(snapshot_at) from cin7_product_availability),
                                  'grading', (select max(changed_at) from grading_sheet_current), 'returns', (select max(source_synced_at) from service_requests)),
  'grading', public.portal_health()->'grading'
);
$$;
