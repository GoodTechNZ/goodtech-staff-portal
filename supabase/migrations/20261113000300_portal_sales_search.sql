-- Returns search was reading every Cin7 sale's full JSON (34k rows, 176 MB) per search and hit the
-- statement timeout. A slim search table (one row per sale: SO, Shopify #, name/contact/email, phone
-- digits, IMEIs/serials from the note and line comments) with trigram indexes answers searches from the
-- index, and the full sale is read only for the ≤25 matches. A trigger keeps it in step with the sync.
create extension if not exists pg_trgm with schema extensions;

create table if not exists public.portal_sales_search (
  cin7_sale_id text primary key,
  order_date date,
  so text,
  ref text,
  who text,       -- lower(customer | contact | email)
  phone text,     -- digits only
  serials text,   -- upper(note + line comments)
  voided boolean not null default false
);
alter table public.portal_sales_search enable row level security;
revoke all on public.portal_sales_search from anon, authenticated;
grant select on public.portal_sales_search to service_role;

create or replace function public.portal_sales_search_row(r public.cin7_sales_raw)
returns public.portal_sales_search language sql immutable as $$
  select r.cin7_sale_id, r.order_date, upper(r.order_number), nullif(r.detail->>'CustomerReference', ''),
         lower(concat_ws(' | ', r.detail->>'Customer', r.detail->>'Contact', r.detail->>'Email')),
         nullif(regexp_replace(coalesce(r.detail->>'Phone', ''), '\D', '', 'g'), ''),
         nullif(upper(concat_ws(' ', r.detail->>'Note', (select string_agg(l->>'Comment', ' ') from jsonb_array_elements(coalesce(r.detail->'Order'->'Lines', '[]'::jsonb)) l))), ''),
         coalesce(r.status, '') ilike '%void%'
$$;

create or replace function public.portal_sales_search_sync()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into portal_sales_search select (portal_sales_search_row(new)).*
  on conflict (cin7_sale_id) do update set order_date = excluded.order_date, so = excluded.so, ref = excluded.ref,
    who = excluded.who, phone = excluded.phone, serials = excluded.serials, voided = excluded.voided;
  return new;
end $$;
drop trigger if exists portal_sales_search_sync on public.cin7_sales_raw;
create trigger portal_sales_search_sync after insert or update of detail, status, order_number, order_date on public.cin7_sales_raw
  for each row execute function public.portal_sales_search_sync();

-- Backfill (applied in date batches: one statement over all 34k sales exceeds the timeout).
insert into public.portal_sales_search select (public.portal_sales_search_row(r)).* from public.cin7_sales_raw r
on conflict (cin7_sale_id) do nothing;

create index if not exists portal_sales_search_so on public.portal_sales_search(so);
create index if not exists portal_sales_search_ref on public.portal_sales_search(ref);
create index if not exists portal_sales_search_date on public.portal_sales_search(order_date desc);
create index if not exists portal_sales_search_who on public.portal_sales_search using gin (who extensions.gin_trgm_ops);
create index if not exists portal_sales_search_phone on public.portal_sales_search using gin (phone extensions.gin_trgm_ops);
create index if not exists portal_sales_search_serials on public.portal_sales_search using gin (serials extensions.gin_trgm_ops);
analyze public.portal_sales_search;

create or replace function public.portal_returns_find(p_q text)
returns jsonb language sql stable security definer set search_path = public, extensions, pg_temp as $$
  with q as (select btrim(coalesce(p_q, '')) s, upper(btrim(coalesce(p_q, ''))) u, lower(btrim(coalesce(p_q, ''))) l,
                    regexp_replace(coalesce(p_q, ''), '\D', '', 'g') digits),
  ids as (
    select x.cin7_sale_id, x.order_date from portal_sales_search x, q
     where length(q.s) >= 3 and not x.voided and x.order_date > current_date - interval '3 years'
       and (x.so = q.u
         or x.ref = q.s
         or (q.s ~ '^#?\d{5}$' and x.ref = '#' || ltrim(q.s, '#'))
         or (q.s ~ '^[A-Za-z0-9-]{8,30}$' and q.s !~* '^SO\d+$' and (x.serials like '%' || q.u || '%'
              or x.cin7_sale_id in (select v.cin7_sale_id::text from staff_shipping_verifications v where v.scanned_imei = q.s and v.verified)))
         or (q.s !~ '^[\d +()-]+$' and x.who like '%' || q.l || '%')
         or (length(q.digits) >= 7 and q.s ~ '^[\d +()-]+$' and x.phone like '%' || right(q.digits, 8) || '%'))
     order by x.order_date desc limit 25
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'saleId', h.cin7_sale_id, 'so', h.order_number, 'date', h.order_date, 'status', h.status,
    'ref', nullif(h.detail->>'CustomerReference', ''), 'rep', h.detail->>'SalesRepresentative',
    'customer', jsonb_build_object('id', h.detail->>'CustomerID', 'name', h.detail->>'Customer', 'contact', h.detail->>'Contact',
                                   'email', h.detail->>'Email', 'phone', h.detail->>'Phone', 'address', h.detail->'ShippingAddress'),
    'note', left(coalesce(h.detail->>'Note', ''), 300),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('sku', l->>'SKU', 'name', l->>'Name', 'qty', (l->>'Quantity')::numeric,
                                                          'price', (l->>'Price')::numeric, 'comment', l->>'Comment'))
                         from jsonb_array_elements(h.detail->'Order'->'Lines') l), '[]'::jsonb),
    'imeis', coalesce((select jsonb_agg(distinct v.scanned_imei) from staff_shipping_verifications v where v.cin7_sale_id::text = h.cin7_sale_id and v.verified), '[]'::jsonb),
    'returns', coalesce((select jsonb_agg(jsonb_build_object('number', pr.number, 'status', pr.status)) from portal_returns pr where pr.cin7_sale_id = h.cin7_sale_id::uuid), '[]'::jsonb)
  ) order by h.order_date desc), '[]'::jsonb)
  from ids join cin7_sales_raw h on h.cin7_sale_id = ids.cin7_sale_id;
$$;
revoke all on function public.portal_returns_find(text) from public, anon, authenticated;
grant execute on function public.portal_returns_find(text) to service_role;
