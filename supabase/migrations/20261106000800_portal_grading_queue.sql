-- Grading sheet sync detail for the Dashboard: what is waiting, what is stuck and why.
--   inFlight  = pending/working saves that the worker can write now (usually ~1 minute).
--   blocked   = pending saves held behind an earlier conflict for the same device; they will not
--               write until that conflict is resolved.
--   conflicts = saves the worker refused because the sheet row was edited by hand.
create or replace function public.portal_grading_queue()
returns jsonb language sql stable set search_path = public, pg_temp as $$
with q as (
  select o.id, o.status, o.revision, o.created_at, o.attempts, o.error, o.payload, r.serial, r.sheet_row, d.metadata->>'model' model,
         exists (select 1 from portal_grading_outbox p where p.record_id = o.record_id and p.revision < o.revision and p.status = 'conflict') blocked
    from portal_grading_outbox o
    join portal_grading_records r on r.id = o.record_id
    left join portal_grading_directory d on d.serial = r.serial
   where o.status in ('pending', 'working', 'conflict')
), items as (
  select case when status = 'conflict' then 'conflict' when blocked then 'blocked' else 'inflight' end kind,
         jsonb_build_object('serial', serial, 'model', model, 'tester', payload->>'tester', 'grade', payload->>'grade',
                            'destination', payload->>'destination', 'createdAt', created_at, 'row', sheet_row, 'status', status,
                            'reason', case when status = 'conflict' then regexp_replace(coalesce(error, ''), '^CONFLICT:\s*', '')
                                           when blocked then 'Waiting for an earlier conflict on this device'
                                           when status = 'working' then 'Writing now' else 'Queued' end) item,
         created_at
    from q
)
select jsonb_build_object(
  'inFlight', (select count(*) from items where kind = 'inflight'),
  'blocked', (select count(*) from items where kind = 'blocked'),
  'conflicts', (select count(*) from items where kind = 'conflict'),
  'items', coalesce((select jsonb_agg(item || jsonb_build_object('kind', kind) order by case kind when 'inflight' then 0 when 'blocked' then 1 else 2 end, created_at) from items), '[]'::jsonb));
$$;
revoke all on function public.portal_grading_queue() from public, anon, authenticated;
grant execute on function public.portal_grading_queue() to service_role;
