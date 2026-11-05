-- Pick lists for every New order (not picked, not shipped, not a quote or draft), oldest first,
-- for the Dashboard's "Print pick lists" button. Read-only.
create or replace function public.portal_new_order_pick_lists()
returns jsonb language sql stable set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(x order by x.document_date, x.document_number), '[]'::jsonb) from (
    select o.document_number, o.reference, o.party, o.document_date,
           coalesce(s.detail->>'Carrier', s.summary->>'Carrier', '') carrier,
           exists(select 1 from staff_pickup_orders p where p.cin7_sale_id::text = o.document_id)
             or coalesce(s.detail->>'Carrier', s.summary->>'Carrier', '') ~* '(pick.?up|collect|1a Elgin)' is_pickup,
           concat_ws(', ', nullif(s.detail->'ShippingAddress'->>'Line1', ''), nullif(s.detail->'ShippingAddress'->>'Line2', ''),
                     nullif(s.detail->'ShippingAddress'->>'City', ''), nullif(s.detail->'ShippingAddress'->>'Postcode', '')) address,
           nullif(btrim(coalesce(s.detail->>'Note', '')), '') note,
           coalesce((select jsonb_agg(jsonb_build_object('sku', l->>'SKU', 'name', l->>'Name', 'qty', (l->>'Quantity')::numeric))
                       from jsonb_array_elements(s.detail->'Order'->'Lines') l), '[]'::jsonb) lines
      from open_cin7_sales_orders o join cin7_sales_raw s on s.cin7_sale_id = o.document_id
     where o.picking_status = 'NOT PICKED' and coalesce(o.shipping_status, '') <> 'SHIPPED'
       and o.operational_stage not in ('QUOTE', 'DRAFT ORDER')
       and coalesce(s.status, '') not in ('VOIDED', 'CANCELLED', 'COMPLETED')
  ) x;
$$;
revoke all on function public.portal_new_order_pick_lists() from public, anon, authenticated;
grant execute on function public.portal_new_order_pick_lists() to service_role;
