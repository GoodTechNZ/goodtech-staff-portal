-- Grading → Testing priority: supplier return cut-off. Devices in SOs on day 7 or later since delivery
-- (day 7 is the last day to raise supplier returns), with model, grade, location and status, plus SOs
-- reaching day 7 tomorrow. Day = NZ today − Delivered date (ASNs Shipment Check, "d/m"; year inferred).
create or replace function public.portal_supplier_cutoff()
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  with today as (select (now() at time zone 'Pacific/Auckland')::date d),
  so as (
    select s.order_number so, s.warehouse, s.delivered,
           case when to_date(s.delivered || '/' || extract(year from t.d), 'DD/MM/YYYY') > t.d
                then to_date(s.delivered || '/' || (extract(year from t.d) - 1), 'DD/MM/YYYY')
                else to_date(s.delivered || '/' || extract(year from t.d), 'DD/MM/YYYY') end delivered_on
      from asn_shipment_check s, today t
     where s.delivered ~ '^\d{1,2}/\d{1,2}$'
  ), sod as (select so.*, (select d from today) - delivered_on days from so),
  dev as (
    select sod.so, a.serial, a.sheet_row, a.grade, nullif(btrim(a.location), '') location, nullif(btrim(a.status), '') status,
           coalesce(nullif(nullif(btrim(d.metadata->>'model'), ''), '#N/A') || coalesce(' ' || nullif(nullif(btrim(d.metadata->>'capacity'), ''), '#N/A'), ''),
                    nullif(d.metadata->>'supplier', ''), '') model
      from sod join asn_ops_rows a on a.order_number = sod.so
      left join portal_grading_directory d on d.serial = a.serial
     where sod.days >= 7
  )
  select jsonb_build_object(
    'today', coalesce((select jsonb_agg(x order by x.days, x.so) from (
        select sod.so, sod.warehouse, sod.delivered_on delivered, sod.days,
               (select count(*) from dev where dev.so = sod.so) devices,
               (select count(*) from dev where dev.so = sod.so and dev.grade in ('', '-', '#N/A')) untested,
               coalesce((select jsonb_agg(jsonb_build_object('serial', serial, 'row', sheet_row, 'model', model, 'grade', nullif(grade, '-'),
                        'tested', grade not in ('', '-', '#N/A'), 'location', location, 'status', status)
                        order by (grade in ('', '-', '#N/A')) desc, location nulls last, model) from dev where dev.so = sod.so), '[]'::jsonb) items
          from sod where sod.days >= 7 and exists (select 1 from asn_ops_rows a where a.order_number = sod.so)) x), '[]'::jsonb),
    'tomorrow', coalesce((select jsonb_agg(jsonb_build_object('so', so, 'delivered', delivered_on,
        'devices', (select count(*) from asn_ops_rows a where a.order_number = sod.so),
        'untested', (select count(*) from asn_ops_rows a where a.order_number = sod.so and a.grade in ('', '-', '#N/A'))) order by so)
        from sod where days = 6 and exists (select 1 from asn_ops_rows a where a.order_number = sod.so)), '[]'::jsonb));
$$;
revoke all on function public.portal_supplier_cutoff() from public, anon, authenticated;
grant execute on function public.portal_supplier_cutoff() to service_role;

-- Served with the testing priority (grading.priority), so no gateway change is needed.
do $$
declare d text := pg_get_functiondef('public.portal_testing_priority()'::regprocedure);
  anchor text := E'''asnSyncedAt'', (select max(synced_at) from asn_ops_sync_log));';
begin
  if position('portal_supplier_cutoff' in d) = 0 then
    if position(anchor in d) = 0 then raise exception 'portal_testing_priority anchor not found'; end if;
    execute replace(d, anchor, E'''asnSyncedAt'', (select max(synced_at) from asn_ops_sync_log),\n    ''cutoff'', public.portal_supplier_cutoff());');
  end if;
end $$;
