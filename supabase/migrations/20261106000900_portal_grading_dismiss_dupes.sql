-- Duplicate grading saves: a 'dismissed' outbox status, and a one-off clean-up of three devices
-- that were graded twice (the sheet already has the correct row for each).

alter table public.portal_grading_outbox drop constraint if exists portal_grading_outbox_status_check;
alter table public.portal_grading_outbox add constraint portal_grading_outbox_status_check
  check (status in ('pending', 'working', 'synced', 'conflict', 'linked', 'dismissed'));

-- A dismissed earlier revision no longer holds later saves back.
create or replace function public.portal_grading_claim()
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare result jsonb;
begin
 insert into portal_grading_health(key,value) values('worker',jsonb_build_object('at',now())) on conflict(key) do update set value=excluded.value,updated_at=now();
 perform portal_grading_autolink();
 with chosen as (
  select q.id from portal_grading_outbox q where ((q.status='pending' and q.available_at<=now()) or (q.status='working' and q.lease_until<now()))
  and not exists(select 1 from portal_grading_outbox prior where prior.record_id=q.record_id and prior.revision<q.revision and prior.status not in ('synced','linked','dismissed'))
  order by q.created_at for update skip locked limit 30
 ), leased as (
  update portal_grading_outbox q set status='working',attempts=attempts+1,lease_id=gen_random_uuid(),lease_until=now()+interval '5 minutes' from chosen where q.id=chosen.id returning q.*
 ) select coalesce(jsonb_agg(to_jsonb(q)||jsonb_build_object('serial',r.serial,'sheet_record_id',r.sheet_record_id,'sheet_row',r.sheet_row,'base',r.sheet_base)),'[]'::jsonb) into result from leased q join portal_grading_records r on r.id=q.record_id;
 return jsonb_build_object('ok',true,'jobs',result);
end $$;

-- Dismiss every unsent save for a record; the sheet row stays as it is and is re-imported as the truth.
create or replace function public.portal_grading_dismiss(p_record uuid, p_reason text)
returns integer language plpgsql set search_path = public, pg_temp as $$
declare n integer;
begin
  update portal_grading_outbox set status = 'dismissed', lease_until = null, synced_at = now(),
         error = left('DISMISSED: ' || coalesce(nullif(btrim(p_reason), ''), 'Duplicate save'), 500)
   where record_id = p_record and status in ('pending', 'working', 'conflict');
  get diagnostics n = row_count;
  update portal_grading_records set managed = false, updated_at = now() where id = p_record;
  return n;
end $$;
revoke all on function public.portal_grading_dismiss(uuid, text) from public, anon, authenticated;
grant execute on function public.portal_grading_dismiss(uuid, text) to service_role;

-- One-off clean-up (6 Nov 2026, requested by Fraser).
do $$
begin
  -- 351682570016683: the worker appended row 35665 (it carries this record's id) but reported a conflict.
  if exists (select 1 from portal_grading_records where id = '656a532e-70f3-420a-a91c-18ebacfd8caa' and serial = '351682570016683') then
    perform portal_grading_dismiss('656a532e-70f3-420a-a91c-18ebacfd8caa', 'Duplicate: already in the sheet at row 35665');
    update portal_grading_records set sheet_record_id = id, sheet_row = 35665 where id = '656a532e-70f3-420a-a91c-18ebacfd8caa' and sheet_record_id is null;
  end if;
  -- 359462823624753: already in the sheet at row 35712; the sheet's hand edits win.
  if exists (select 1 from portal_grading_records where id = '722ecf3c-8b04-496f-ac5f-4267eb54e7a7' and serial = '359462823624753') then
    perform portal_grading_dismiss('722ecf3c-8b04-496f-ac5f-4267eb54e7a7', 'Duplicate: already in the sheet at row 35712');
  end if;
  -- 352941885309111: row 36049 was written for 355130342680796 and then retyped as this serial by hand.
  -- The sheet row is the truth: the record behind it takes this serial, and the unsent save is hidden.
  if exists (select 1 from portal_grading_records where id = '304dec22-8ede-41f0-b417-fa40fb38b582' and serial = '352941885309111') then
    perform portal_grading_dismiss('304dec22-8ede-41f0-b417-fa40fb38b582', 'Duplicate: already in the sheet at row 36049');
    update portal_grading_records set managed = false, serial = '352941885309111', updated_at = now()
     where id = '1c4a9dd5-5877-4e93-948d-ab1a8c9bbdcf' and serial = '355130342680796';
    update portal_grading_records set linked_record_id = '1c4a9dd5-5877-4e93-948d-ab1a8c9bbdcf', updated_at = now()
     where id = '304dec22-8ede-41f0-b417-fa40fb38b582';
  end if;
end $$;
