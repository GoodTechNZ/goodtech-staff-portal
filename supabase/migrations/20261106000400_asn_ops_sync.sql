-- ASNs DB → Supabase for the operations dashboard testing and PO cards.
--
-- An Apps Script in ASNs DB (apps-script/AsnOpsSync.gs) posts a snapshot every 10 minutes:
--   * ASNs tab rows with column AG (PO) blank: A ordernumber, B shipment, F serial, AA grade,
--     AD status, AF location.
--   * Shipment Check rows: A SO (= ASNs ordernumber), B warehouse, AL Delivered.
-- Each snapshot replaces the previous one. Counts are derived exactly as the sheet does:
--   Received · not tested = no grade, and the order has a Delivered date in Shipment Check.
--   Graded · not POed     = graded, PO blank. Locked if status/location mentions lock, MDM or RML;
--                           Repairs if any other status note or a Repairs location; otherwise ready for PO.
-- Each serial counts once (its last row in the ASNs tab).

create table if not exists public.asn_ops_rows (
  serial text primary key,
  sheet_row integer not null,
  order_number text not null default '',
  shipment text not null default '',
  grade text not null default '',
  status text not null default '',
  location text not null default ''
);
comment on table public.asn_ops_rows is 'Snapshot of ASNs DB / ASNs rows whose PO (column AG) is blank, one row per serial. Replaced on every sync from apps-script/AsnOpsSync.gs.';

create table if not exists public.asn_shipment_check (
  order_number text primary key,
  warehouse text not null default '',
  delivered text not null default ''
);
comment on table public.asn_shipment_check is 'Snapshot of ASNs DB / Shipment Check: SO (column A), warehouse (B) and Delivered (AL). Replaced on every sync.';

create table if not exists public.asn_ops_sync_log (
  id bigint generated always as identity primary key,
  synced_at timestamptz not null default now(),
  asn_rows_total integer,
  asn_rows_no_po integer,
  shipments integer
);

alter table public.asn_ops_rows enable row level security;
alter table public.asn_shipment_check enable row level security;
alter table public.asn_ops_sync_log enable row level security;
revoke all on public.asn_ops_rows, public.asn_shipment_check, public.asn_ops_sync_log from anon, authenticated;
grant select, insert, update, delete on public.asn_ops_rows, public.asn_shipment_check, public.asn_ops_sync_log to service_role;

-- Replaces both snapshots atomically. p = {rowsTotal, rows:[{row,serial,order,shipment,grade,status,location}], shipments:[{order,warehouse,delivered}]}
create or replace function public.asn_ops_ingest(p jsonb)
returns jsonb language plpgsql volatile set search_path = '' as $$
declare n_rows integer; n_ship integer;
begin
  if jsonb_typeof(p->'rows') <> 'array' or jsonb_typeof(p->'shipments') <> 'array' then raise exception 'rows and shipments are required'; end if;
  if jsonb_array_length(p->'shipments') = 0 then raise exception 'Shipment Check is empty; refusing to clear it'; end if;
  delete from public.asn_ops_rows where true;
  insert into public.asn_ops_rows(serial, sheet_row, order_number, shipment, grade, status, location)
  select distinct on (btrim(x->>'serial')) btrim(x->>'serial'), (x->>'row')::integer, btrim(coalesce(x->>'order', '')), btrim(coalesce(x->>'shipment', '')),
         btrim(coalesce(x->>'grade', '')), left(btrim(coalesce(x->>'status', '')), 1000), left(btrim(coalesce(x->>'location', '')), 200)
    from jsonb_array_elements(p->'rows') x
   where btrim(coalesce(x->>'serial', '')) <> ''
   order by btrim(x->>'serial'), (x->>'row')::integer desc;
  get diagnostics n_rows = row_count;
  delete from public.asn_shipment_check where true;
  insert into public.asn_shipment_check(order_number, warehouse, delivered)
  select distinct on (btrim(x->>'order')) btrim(x->>'order'), btrim(coalesce(x->>'warehouse', '')), btrim(coalesce(x->>'delivered', ''))
    from jsonb_array_elements(p->'shipments') x
   where btrim(coalesce(x->>'order', '')) <> ''
   order by btrim(x->>'order'), (btrim(coalesce(x->>'delivered', '')) <> '') desc;
  get diagnostics n_ship = row_count;
  insert into public.asn_ops_sync_log(asn_rows_total, asn_rows_no_po, shipments) values ((p->>'rowsTotal')::integer, n_rows, n_ship);
  delete from public.asn_ops_sync_log where synced_at < now() - interval '30 days';
  return jsonb_build_object('ok', true, 'rows', n_rows, 'shipments', n_ship);
end $$;

-- Testing and PO queues from the latest snapshot.
create or replace function public.asn_ops_summary()
returns jsonb language sql stable set search_path = '' as $$
with r as (
  select a.*, s.delivered,
         a.grade not in ('', '-', '#N/A') graded,
         (a.status || ' ' || a.location) ~* '(lock|mdm|rml)' is_locked
    from public.asn_ops_rows a left join public.asn_shipment_check s on s.order_number = a.order_number
), q as (
  select *, case when not graded then case when coalesce(delivered, '') <> '' then 'untested' end
                 when is_locked then 'locked'
                 when status <> '' or location ~* 'repair' then 'repairs'
                 else 'ready' end queue
    from r
)
select jsonb_build_object(
  'syncedAt', (select max(synced_at) from public.asn_ops_sync_log),
  'untested', (select count(*) from q where queue = 'untested'),
  'gradedNoPo', (select count(*) from q where graded),
  'readyForPo', (select count(*) from q where queue = 'ready'),
  'repairsNoPo', (select count(*) from q where queue = 'repairs'),
  'lockedNoPo', (select count(*) from q where queue = 'locked'),
  'lists', jsonb_build_object(
    'untested', (select coalesce(jsonb_agg(x), '[]') from (select order_number, shipment, delivered, count(*) devices from q where queue = 'untested' group by 1, 2, 3 order by min(sheet_row)) x),
    'ready', (select coalesce(jsonb_agg(x), '[]') from (select serial, order_number, grade, location, status from q where queue = 'ready' order by sheet_row desc limit 50) x),
    'repairs', (select coalesce(jsonb_agg(x), '[]') from (select serial, order_number, grade, location, status from q where queue = 'repairs' order by sheet_row desc limit 50) x),
    'locked', (select coalesce(jsonb_agg(x), '[]') from (select serial, order_number, grade, location, status from q where queue = 'locked' order by sheet_row desc limit 50) x)));
$$;

revoke all on function public.asn_ops_ingest(jsonb) from public, anon, authenticated;
revoke all on function public.asn_ops_summary() from public, anon, authenticated;
grant execute on function public.asn_ops_ingest(jsonb) to service_role;
grant execute on function public.asn_ops_summary() to service_role;
