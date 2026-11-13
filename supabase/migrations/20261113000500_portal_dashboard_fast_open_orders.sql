-- Dashboard speed. open_cin7_sales_orders decides "open" by merging each sale's summary + detail JSON;
-- 8,000 sales still have Cin7 status INVOICED, so the Dashboard (1.6 s) and pick lists (0.7 s) merged
-- thousands of large JSON documents to find ~36 open orders, and timed out when the Cin7 sync was busy.
-- portal_sales_search (trigger-maintained, see 20261113000300) now also stores the Cin7 status and the
-- same "open" rule; both functions start from those open ids, so only the open sales are read in full
-- (Dashboard ~0.2 s, pick lists ~0.03 s). Also indexes cin7_sales_raw.list_fetched_at (freshness).
alter table public.portal_sales_search add column if not exists status text, add column if not exists open boolean not null default false;

create or replace function public.portal_sales_search_row(r public.cin7_sales_raw)
returns public.portal_sales_search language sql immutable as $$
  select r.cin7_sale_id, r.order_date, upper(r.order_number), nullif(r.detail->>'CustomerReference', ''),
         lower(concat_ws(' | ', r.detail->>'Customer', r.detail->>'Contact', r.detail->>'Email')),
         nullif(regexp_replace(coalesce(r.detail->>'Phone', ''), '\D', '', 'g'), ''),
         nullif(upper(concat_ws(' ', r.detail->>'Note', (select string_agg(l->>'Comment', ' ') from jsonb_array_elements(coalesce(r.detail->'Order'->'Lines', '[]'::jsonb)) l))), ''),
         coalesce(r.status, '') ilike '%void%',
         r.status,
         r.status = any (array['NEW','DRAFT','ORDERING','ESTIMATING','ESTIMATED','ORDERED','PICKING','PICKED','PACKING','PACKED','SHIPPING','INVOICING','INVOICED'])
           and (coalesce(coalesce(r.detail->>'CombinedShippingStatus', r.summary->>'CombinedShippingStatus'), '') <> 'SHIPPED'
                or coalesce(r.detail->>'CombinedInvoiceStatus', r.summary->>'CombinedInvoiceStatus') in ('NOT INVOICED', 'PARTIALLY INVOICED'))
$$;

create or replace function public.portal_sales_search_sync()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into portal_sales_search select (portal_sales_search_row(new)).*
  on conflict (cin7_sale_id) do update set order_date = excluded.order_date, so = excluded.so, ref = excluded.ref,
    who = excluded.who, phone = excluded.phone, serials = excluded.serials, voided = excluded.voided,
    status = excluded.status, open = excluded.open;
  return new;
end $$;
drop trigger if exists portal_sales_search_sync on public.cin7_sales_raw;
create trigger portal_sales_search_sync after insert or update of detail, summary, status, order_number, order_date on public.cin7_sales_raw
  for each row execute function public.portal_sales_search_sync();

-- Backfill status / open (only open-status sales can be open).
update public.portal_sales_search x set status = r.status, open = (public.portal_sales_search_row(r)).open
  from public.cin7_sales_raw r where r.cin7_sale_id = x.cin7_sale_id
   and r.status = any (array['NEW','DRAFT','ORDERING','ESTIMATING','ESTIMATED','ORDERED','PICKING','PICKED','PACKING','PACKED','SHIPPING','INVOICING','INVOICED']);
update public.portal_sales_search x set status = r.status from public.cin7_sales_raw r where r.cin7_sale_id = x.cin7_sale_id and x.status is null;

create index if not exists portal_sales_search_open on public.portal_sales_search(cin7_sale_id) where open;
create index if not exists cin7_sales_raw_list_fetched_idx on public.cin7_sales_raw(list_fetched_at desc);

do $$
declare d text;
begin
  d := pg_get_functiondef('public.portal_ops_dashboard()'::regprocedure);
  if position('portal_sales_search' in d) = 0 then
    if position(E'    from open_cin7_sales_orders o join cin7_sales_raw s on s.cin7_sale_id = o.document_id\n   where o.operational_stage' in d) = 0 then raise exception 'ops anchor not found'; end if;
    d := replace(d, E'    from open_cin7_sales_orders o join cin7_sales_raw s on s.cin7_sale_id = o.document_id\n   where o.operational_stage',
                    E'    from open_cin7_sales_orders o join cin7_sales_raw s on s.cin7_sale_id = o.document_id\n   where o.document_id in (select cin7_sale_id from portal_sales_search where open)\n     and o.operational_stage');
    execute d;
  end if;
  d := pg_get_functiondef('public.portal_new_order_pick_lists()'::regprocedure);
  if position('portal_sales_search' in d) = 0 then
    if position(E'     where o.picking_status = ''NOT PICKED''' in d) = 0 then raise exception 'picklists anchor not found'; end if;
    d := replace(d, E'     where o.picking_status = ''NOT PICKED''',
                    E'     where o.document_id in (select cin7_sale_id from portal_sales_search where open)\n       and o.picking_status = ''NOT PICKED''');
    execute d;
  end if;
end $$;
analyze public.portal_sales_search;
