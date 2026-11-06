-- Printing pick lists from the Dashboard also authorises the Pick in Cin7 once the person confirms
-- the lists printed, so those orders move from New to Picked (awaiting packing).
-- portal_pick_authorisations records each request so an order is never picked twice from the
-- portal, and so the Dashboard shows it as picked before the next Cin7 sales sync (10 minutes).

create table if not exists public.portal_pick_authorisations (
  sale_id text primary key,
  order_number text not null,
  status text not null check (status in ('requesting', 'authorised', 'review')),
  staff_id uuid not null references public.staff(id),
  staff_name text not null,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.portal_pick_authorisations enable row level security;
revoke all on public.portal_pick_authorisations from anon, authenticated;
grant select, insert, update on public.portal_pick_authorisations to service_role;

-- New orders still to pick (with their Cin7 sale id), excluding any the portal has already sent to Cin7.
create or replace function public.portal_new_order_pick_lists()
returns jsonb language sql stable set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(x order by x.document_date, x.document_number), '[]'::jsonb) from (
    select o.document_id id, o.document_number, o.reference, o.party, o.document_date,
           coalesce(s.detail->>'Carrier', s.summary->>'Carrier', '') carrier,
           exists(select 1 from staff_pickup_orders p where p.cin7_sale_id::text = o.document_id)
             or coalesce(s.detail->>'Carrier', s.summary->>'Carrier', '') ~* '(pick.?up|collect|1a Elgin)' is_pickup,
           concat_ws(', ', nullif(s.detail->'ShippingAddress'->>'Line1', ''), nullif(s.detail->'ShippingAddress'->>'Line2', ''),
                     nullif(s.detail->'ShippingAddress'->>'City', ''), nullif(s.detail->'ShippingAddress'->>'Postcode', '')) address,
           nullif(btrim(coalesce(s.detail->>'Note', '')), '') note,
           coalesce((select jsonb_agg(jsonb_build_object('sku', l->>'SKU', 'name', l->>'Name', 'qty', (l->>'Quantity')::numeric))
                       from jsonb_array_elements(s.detail->'Order'->'Lines') l), '[]'::jsonb) lines,
           a.status pick_status, a.error pick_error
      from open_cin7_sales_orders o join cin7_sales_raw s on s.cin7_sale_id = o.document_id
      left join portal_pick_authorisations a on a.sale_id = o.document_id
     where o.picking_status = 'NOT PICKED' and coalesce(o.shipping_status, '') <> 'SHIPPED'
       and o.operational_stage not in ('QUOTE', 'DRAFT ORDER')
       and coalesce(s.status, '') not in ('VOIDED', 'CANCELLED', 'COMPLETED')
       and coalesce(a.status, '') <> 'authorised'
  ) x;
$$;

-- Claims printed orders for pick authorisation and returns what Cin7 needs for each. An order is
-- only returned if it is still not picked and no earlier portal request is in flight or done;
-- 'review' requests (an earlier failure) and abandoned ones can be retried; the gateway reads the
-- Pick in Cin7 first, so a retry never authorises twice.
create or replace function public.portal_pick_prepare(p_ids text[], p_staff uuid, p_name text)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare out jsonb := '[]'::jsonb; r record;
begin
  if coalesce(array_length(p_ids, 1), 0) = 0 or array_length(p_ids, 1) > 40 then raise exception 'Choose up to 40 orders.'; end if;
  for r in
    select o.document_id id, o.document_number num, s.detail
      from open_cin7_sales_orders o join cin7_sales_raw s on s.cin7_sale_id = o.document_id
     where o.document_id = any(p_ids) and o.picking_status = 'NOT PICKED' and coalesce(o.shipping_status, '') <> 'SHIPPED'
       and o.operational_stage not in ('QUOTE', 'DRAFT ORDER') and coalesce(s.status, '') not in ('VOIDED', 'CANCELLED', 'COMPLETED')
       and s.detail->'Order'->>'Status' = 'AUTHORISED'
     order by o.document_number
  loop
    insert into portal_pick_authorisations(sale_id, order_number, status, staff_id, staff_name)
    values (r.id, r.num, 'requesting', p_staff, p_name)
    on conflict (sale_id) do update set status = 'requesting', staff_id = excluded.staff_id, staff_name = excluded.staff_name, error = null, updated_at = now()
      where portal_pick_authorisations.status = 'review'
         or (portal_pick_authorisations.status = 'requesting' and portal_pick_authorisations.updated_at < now() - interval '5 minutes');
    if not found then continue; end if;
    out := out || jsonb_build_array(jsonb_build_object(
      'id', r.id, 'number', r.num,
      'tasks', coalesce((select jsonb_agg(f->>'TaskID') from jsonb_array_elements(r.detail->'Fulfilments') f), '[]'::jsonb),
      'location', r.detail->>'Location',
      'lines', coalesce((select jsonb_agg(jsonb_build_object('ProductID', l->>'ProductID', 'SKU', l->>'SKU', 'Name', l->>'Name',
                                   'Quantity', (l->>'Quantity')::numeric, 'NonInventory', coalesce(p.product_type, '') <> 'Stock'))
                           from jsonb_array_elements(r.detail->'Order'->'Lines') l
                           left join cin7_products p on p.product_id::text = l->>'ProductID'), '[]'::jsonb)));
  end loop;
  return out;
end $$;

create or replace function public.portal_pick_result(p_id text, p_status text, p_error text)
returns void language sql set search_path = public, pg_temp as $$
  update portal_pick_authorisations set status = p_status, error = left(p_error, 500), updated_at = now()
   where sale_id = p_id and status = 'requesting' and p_status in ('authorised', 'review');
$$;

revoke all on function public.portal_pick_prepare(text[], uuid, text) from public, anon, authenticated;
revoke all on function public.portal_pick_result(text, text, text) from public, anon, authenticated;
grant execute on function public.portal_pick_prepare(text[], uuid, text) to service_role;
grant execute on function public.portal_pick_result(text, text, text) to service_role;

-- Dashboard queues: an order the portal has authorised counts as Picked straight away.
do $$
declare d text := pg_get_functiondef('public.portal_ops_dashboard'::regproc);
begin
  if position('portal_pick_authorisations' in d) = 0 then
    d := replace(d, 'o.operational_stage, o.picking_status, o.packing_status,',
      'o.operational_stage, case when o.picking_status = ''NOT PICKED'' and exists(select 1 from portal_pick_authorisations a where a.sale_id = o.document_id and a.status = ''authorised'') then ''PICKED'' else o.picking_status end picking_status, o.packing_status,');
    if position('portal_pick_authorisations' in d) = 0 then raise exception 'portal_ops_dashboard patch did not apply'; end if;
    execute d;
  end if;
end $$;
