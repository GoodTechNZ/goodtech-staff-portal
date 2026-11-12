-- Supplier returns (day 7+): only devices still untested or in Locked; orders with none drop out.
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
  rows_ as (
    select a.*, a.grade in ('', '-', '#N/A') untested, btrim(a.location) ilike 'locked%' locked
      from asn_ops_rows a
  ), act as (select * from rows_ where untested or locked),
  dev as (
    select sod.so, a.serial, a.sheet_row, a.grade, a.untested, nullif(btrim(a.location), '') location, nullif(btrim(a.status), '') status,
           coalesce(nullif(nullif(btrim(d.metadata->>'model'), ''), '#N/A') || coalesce(' ' || nullif(nullif(btrim(d.metadata->>'capacity'), ''), '#N/A'), ''),
                    nullif(d.metadata->>'supplier', ''), '') model
      from sod join act a on a.order_number = sod.so
      left join portal_grading_directory d on d.serial = a.serial
     where sod.days >= 7
  )
  select jsonb_build_object(
    'today', coalesce((select jsonb_agg(x order by x.days, x.so) from (
        select sod.so, sod.warehouse, sod.delivered_on delivered, sod.days,
               (select count(*) from dev where dev.so = sod.so) devices,
               (select count(*) from dev where dev.so = sod.so and dev.untested) untested,
               coalesce((select jsonb_agg(jsonb_build_object('serial', serial, 'row', sheet_row, 'model', model, 'grade', nullif(grade, '-'),
                        'tested', not untested, 'location', location, 'status', status)
                        order by untested desc, location nulls last, model) from dev where dev.so = sod.so), '[]'::jsonb) items
          from sod where sod.days >= 7 and exists (select 1 from dev where dev.so = sod.so)) x), '[]'::jsonb),
    'tomorrow', coalesce((select jsonb_agg(jsonb_build_object('so', so, 'delivered', delivered_on,
        'devices', (select count(*) from act a where a.order_number = sod.so),
        'untested', (select count(*) from act a where a.order_number = sod.so and a.untested)) order by so)
        from sod where days = 6 and exists (select 1 from act a where a.order_number = sod.so)), '[]'::jsonb));
$$;
