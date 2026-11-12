-- Returns tab: find a customer's Cin7 order, log a return (reason, outcome) against the signed-in staff,
-- email an eShip return label, mark it received, and create the Cin7 Replacement / Warranty SO with a
-- matching eShip order (shipped from the Shipping tab like any other SO).

create sequence if not exists public.portal_return_seq start 1001;

create table if not exists public.portal_returns (
  id uuid primary key default gen_random_uuid(),
  number text not null unique default ('RT' || nextval('public.portal_return_seq')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.staff(id),
  created_by_name text not null,
  cin7_sale_id uuid,
  so text,
  order_ref text,
  customer jsonb not null default '{}',            -- {id, name, email, phone, address{Line1,Line2,City,State,Postcode,Country}}
  items jsonb not null default '[]',               -- [{sku, name, price, imei}]
  reason_category text not null,
  reason_detail text not null default '',
  outcome text not null check (outcome in ('refund', 'replacement', 'warranty', 'undecided')),
  status text not null default 'open' check (status in ('open', 'label_sent', 'received', 'outbound', 'closed', 'cancelled')),
  return_label jsonb,                              -- {eship_order_id, order_number, tracking, created_at, email_id}
  received_at timestamptz,
  received_by text,
  outbound jsonb,                                  -- {kind, cin7_sale_id, so, ref, eship_order_id, created_at}
  closed_note text
);
create index if not exists portal_returns_status on public.portal_returns(status, created_at desc);
create index if not exists portal_returns_sale on public.portal_returns(cin7_sale_id);

create table if not exists public.portal_return_events (
  id bigint generated always as identity primary key,
  return_id uuid not null references public.portal_returns(id),
  at timestamptz not null default now(),
  staff_id uuid,
  staff_name text,
  action text not null,
  details jsonb not null default '{}'
);
create index if not exists portal_return_events_return on public.portal_return_events(return_id, at);

-- Emails the service mailbox sends (apps-script/ReturnsMailer.gs), e.g. return labels.
create table if not exists public.portal_outbound_email (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  return_id uuid references public.portal_returns(id),
  to_email text not null,
  subject text not null,
  body text not null,
  attachment_name text,
  attachment_b64 text,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed')),
  attempts integer not null default 0,
  sent_at timestamptz,
  error text
);
create index if not exists portal_outbound_email_pending on public.portal_outbound_email(status, created_at) where status in ('pending', 'sending');

alter table public.portal_returns enable row level security;
alter table public.portal_return_events enable row level security;
alter table public.portal_outbound_email enable row level security;
revoke all on public.portal_returns, public.portal_return_events, public.portal_outbound_email from anon, authenticated;
grant select, insert, update on public.portal_returns, public.portal_return_events, public.portal_outbound_email to service_role;
grant usage on sequence public.portal_return_seq to service_role;

-- Find a customer's Cin7 sales (last 3 years) by SO, Shopify #, IMEI/serial, name, email or phone.
create or replace function public.portal_returns_find(p_q text)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  with q as (select btrim(coalesce(p_q, '')) s, upper(btrim(coalesce(p_q, ''))) u,
                    regexp_replace(coalesce(p_q, ''), '\D', '', 'g') digits),
  hits as (
    select r.* from cin7_sales_raw r, q
     where length(q.s) >= 3 and r.order_date > current_date - interval '3 years'
       and coalesce(r.status, '') not ilike '%void%'
       and (r.order_number = q.u
         or r.detail->>'CustomerReference' = q.s
         or (q.s ~ '^#?\d{5}$' and r.detail->>'CustomerReference' = '#' || ltrim(q.s, '#'))
         or (q.s ~ '^[A-Za-z0-9-]{8,30}$' and q.s !~ '^SO\d+$' and (r.detail->>'Note' ilike '%' || q.s || '%' or (r.detail->'Order'->'Lines')::text ilike '%' || q.s || '%'
              or exists (select 1 from staff_shipping_verifications v where v.scanned_imei = q.s and v.cin7_sale_id::text = r.cin7_sale_id::text)))
         or (q.s !~ '^\d+$' and (r.detail->>'Customer' ilike '%' || q.s || '%' or r.detail->>'Email' ilike '%' || q.s || '%'))
         or (length(q.digits) >= 7 and q.s ~ '^[\d +()-]+$' and regexp_replace(coalesce(r.detail->>'Phone', ''), '\D', '', 'g') like '%' || right(q.digits, 8) || '%'))
     order by r.order_date desc limit 25
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
    'imeis', coalesce((select jsonb_agg(distinct v.scanned_imei) from staff_shipping_verifications v where v.cin7_sale_id::text = h.cin7_sale_id::text and v.verified), '[]'::jsonb),
    'returns', coalesce((select jsonb_agg(jsonb_build_object('number', pr.number, 'status', pr.status)) from portal_returns pr where pr.cin7_sale_id = h.cin7_sale_id::uuid), '[]'::jsonb)
  ) order by h.order_date desc), '[]'::jsonb) from hits h;
$$;
revoke all on function public.portal_returns_find(text) from public, anon, authenticated;
grant execute on function public.portal_returns_find(text) to service_role;

-- Mail token for apps-script/ReturnsMailer.gs (set by the setup step; the token itself is never stored).
insert into public.portal_config(key, value) values ('returns_mail_token_sha256', '') on conflict (key) do nothing;
