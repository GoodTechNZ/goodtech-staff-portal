-- Grading: link to the existing sheet row instead of blocking when the serial is already in
-- ASNs DB / Grading with the same grade.
--
-- Before: a new save for a serial that already had a row failed with "saved by another tester",
-- and a save that raced a manual sheet entry ended as an outbox conflict
-- ("CONFLICT: Serial was added to the sheet separately.") that blocked every later revision.
-- Now:
--   * save: when the serial already has a record with the same grade, the save links to it
--     (no duplicate row, nothing queued). A different grade is still refused, with the row shown.
--   * outbox: pending/conflict jobs whose record never got a sheet row are linked when the sheet
--     already has the serial with the same grade. Runs on every worker claim, ack and import.
--   * linked duplicates are hidden from lookups so the serial resolves to the sheet row.

alter table public.portal_grading_records add column if not exists linked_record_id uuid references public.portal_grading_records(id);
comment on column public.portal_grading_records.linked_record_id is 'Set when this portal-created record was linked to an existing sheet row for the same serial and grade instead of being written as a duplicate.';

alter table public.portal_grading_outbox drop constraint if exists portal_grading_outbox_status_check;
alter table public.portal_grading_outbox add constraint portal_grading_outbox_status_check
  check (status = any (array['pending','working','synced','conflict','linked']));
alter table public.portal_grading_outbox add column if not exists linked_sheet_row integer;

create or replace function public.portal_grading_autolink()
returns integer language plpgsql volatile set search_path = public, pg_temp as $$
declare n integer;
begin
  with cand as (
    select r.id rec_id, s.id sheet_id, s.sheet_row
      from portal_grading_records r
      join lateral (
        select x.id, x.sheet_row from portal_grading_records x
         where x.serial = r.serial and x.id <> r.id and x.sheet_row is not null and x.linked_record_id is null
           and x.record->>'grade' = r.record->>'grade'
         order by x.sheet_row desc limit 1
      ) s on true
     where r.sheet_row is null and r.linked_record_id is null and r.managed
       and exists (select 1 from portal_grading_outbox q where q.record_id = r.id and q.status in ('pending','conflict'))
       and not exists (select 1 from portal_grading_outbox q where q.record_id = r.id and q.status = 'working' and q.lease_until > now())
     for update of r skip locked
  ), recs as (
    update portal_grading_records r set linked_record_id = c.sheet_id, updated_at = now()
      from cand c where r.id = c.rec_id returning r.id, c.sheet_row
  ), jobs as (
    update portal_grading_outbox q set status = 'linked', linked_sheet_row = recs.sheet_row, synced_at = now(), lease_until = null,
           error = 'LINKED: Serial already in the sheet at row ' || recs.sheet_row || ' with the same grade.'
      from recs where q.record_id = recs.id and q.status in ('pending','conflict') returning q.id
  ) select count(*) into n from jobs;
  return n;
end $$;

create or replace function public.portal_grading_lookup(p_serial text, p_id uuid default null::uuid)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare r portal_grading_records; d jsonb; n integer; state text;
begin
 select metadata into d from portal_grading_directory where serial=p_serial;
 if d is null then
  select jsonb_build_object('model',model,'supplier',description,'shipment',shipment_number,'capacity','','colour','') into d from assurant_shipment_device_history where serial_number=p_serial limit 1;
 end if;
 select count(*) into n from portal_grading_records where serial=p_serial and linked_record_id is null;
 if p_id is null and n>1 then return jsonb_build_object('needsSelection',true,'serial',p_serial,'candidates',(select jsonb_agg(jsonb_build_object('recordId',id,'row',sheet_row,'grade',record->>'grade','location',record->>'location','tester',record->>'tester','status',record->>'status')) from portal_grading_records where serial=p_serial and linked_record_id is null)); end if;
 select * into r from portal_grading_records where serial=p_serial and (p_id is null or id=p_id) and linked_record_id is null limit 1;
 if p_id is not null and r.id is null then raise exception 'Record changed. Scan again.';end if;
 if r.id is null and d is null then raise exception 'No matching device. Refresh the shipment list after the next sheet import.';end if;
 if r.id is not null then select status into state from portal_grading_outbox where record_id=r.id order by revision desc limit 1;end if;
 d:=jsonb_set(coalesce(d,'{}'::jsonb),'{colour}',to_jsonb(public.portal_grading_colour(d->>'colour')));
 if r.record is not null then r.record:=jsonb_set(r.record,'{colour}',to_jsonb(public.portal_grading_colour(r.record->>'colour')));end if;
 return jsonb_build_object('device',coalesce(d,'{}'::jsonb)||jsonb_build_object('serial',p_serial,'recordId',r.id,'version',coalesce(r.revision,0)::text,'row',r.sheet_row,'model',coalesce(nullif(d->>'model',''),'Device')),
 'record',coalesce(r.record,jsonb_build_object('grade','','colour',coalesce(d->>'colour',''),'status','','location','','tester','','date','','battery','','tests','{}'::jsonb,'notes','','testedAt','','destination','')),
 'sync',coalesce(state,'synced'));
end $$;

create or replace function public.portal_grading_save(p jsonb)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare r portal_grading_records; q portal_grading_outbox; rid uuid; sid uuid; v_serial text; rec jsonb; t text; v text; existing portal_grading_records; n_existing integer;
begin
 p:=jsonb_set(p,'{record,colour}',to_jsonb(public.portal_grading_colour(p->'record'->>'colour')));
 v_serial:=p->>'serial'; sid:=(p->>'saveId')::uuid;
 if v_serial is null or v_serial !~ '^[A-Za-z0-9-]{5,30}$' or sid is null or nullif(p->>'owner','') is null then raise exception 'Invalid save request';end if;
 perform pg_advisory_xact_lock(hashtext('portal-grading:'||v_serial));
 select * into q from portal_grading_outbox where id=sid;
 if found then
  if q.owner_id<>p->>'owner' or jsonb_set(q.payload,'{colour}',to_jsonb(public.portal_grading_colour(q.payload->>'colour'))) is distinct from p->'record' or (select x.serial from portal_grading_records x where x.id=q.record_id)<>v_serial then raise exception 'Save identifier already used';end if;
  return jsonb_build_object('ok',true)||portal_grading_lookup(v_serial,q.record_id);
 end if;
 rec:=p->'record';
 if coalesce(rec->>'grade','') not in ('1','2','3') then raise exception 'Select a grade';end if;
 foreach t in array array['colour','location','tester'] loop
  v:=rec->>t;if nullif(btrim(v),'') is null or length(v)>150 or upper(btrim(v))='X' then raise exception 'Complete %',t;end if;
 end loop;
 if coalesce(rec->>'destination','') not in ('Ready For Sale','Repairs','Locked') then raise exception 'Select a destination';end if;
 if rec->>'location' is distinct from (case rec->>'destination' when 'Ready For Sale' then 'Cabinet' else rec->>'destination' end) then raise exception 'Invalid destination location';end if;
 if coalesce(rec->>'battery','')<>'' and (rec->>'battery' !~ '^\d{1,3}$' or (rec->>'battery')::integer>100) then raise exception 'Battery must be 0–100';end if;
 foreach t in array array['Display','Touchscreen','Front camera','Rear cameras','Microphone','Speakers','Buttons','Charging','Wi-Fi','Bluetooth','Mobile network','Biometrics'] loop
  if coalesce(rec->'tests'->>t,'') not in ('Pass','Fail','Not applicable') then raise exception 'Record every functional test';end if;
 end loop;
 if exists(select 1 from jsonb_each_text(rec->'tests') where value='Fail') and nullif(btrim(rec->>'status'),'') is null then raise exception 'Select Device status when a test fails';end if;
 if rec->>'date' is null or rec->>'date' !~ '^\d{4}-\d{2}-\d{2}$' or to_char((rec->>'date')::date,'YYYY-MM-DD')<>rec->>'date' then raise exception 'Select a valid date';end if;
 if rec->>'notes' is null or length(rec->>'notes')>5000 or rec->>'status' is null or length(rec->>'status')>1000 then raise exception 'Invalid notes or status';end if;
 rid:=nullif(p->>'recordId','')::uuid;
 if rid is null then
  select count(*) into n_existing from portal_grading_records where serial=v_serial and linked_record_id is null;
  if n_existing>0 then
   -- Already recorded. Same grade: link to that row rather than blocking or writing a duplicate.
   select * into existing from portal_grading_records
    where serial=v_serial and linked_record_id is null and record->>'grade'=rec->>'grade'
    order by sheet_row is null, sheet_row desc limit 1;
   if existing.id is not null and (n_existing=1 or (select count(*) from portal_grading_records where serial=v_serial and linked_record_id is null and record->>'grade'=rec->>'grade')=1) then
    return jsonb_build_object('ok',true,'linked',true,'linkedRow',existing.sheet_row,'linkedTester',existing.record->>'tester')||portal_grading_lookup(v_serial,existing.id);
   end if;
   select * into existing from portal_grading_records where serial=v_serial and linked_record_id is null order by sheet_row desc nulls last limit 1;
   if n_existing=1 then
    raise exception 'Already in the Grading sheet%as grade % by %. Open the existing record to change it.',
     coalesce(' (row '||existing.sheet_row||') ',' '), coalesce(nullif(existing.record->>'grade',''),'?'), coalesce(nullif(existing.record->>'tester',''),'another tester');
   end if;
   raise exception 'This serial has % rows in the Grading sheet. Scan again and choose the row to update.', n_existing;
  end if;
  perform portal_grading_lookup(v_serial,null);
  if p->>'version' is distinct from '0' then raise exception 'Record changed. Scan again.';end if;
 else
  select * into r from portal_grading_records where id=rid and portal_grading_records.serial=v_serial and linked_record_id is null for update;
  if not found or r.revision::text is distinct from p->>'version' then raise exception 'This record changed since you opened it. Scan again before saving.';end if;
 end if;
 if rid is null then
  insert into portal_grading_records(serial,record,managed) values(v_serial,rec||jsonb_build_object('testedAt',now()),true) returning * into r;
 else
  update portal_grading_records set record=rec||jsonb_build_object('testedAt',now()),managed=true,revision=revision+1,updated_at=now() where id=rid returning * into r;
 end if;
 insert into portal_grading_outbox(id,record_id,revision,payload,owner_id) values(sid,r.id,r.revision,rec,p->>'owner');
 return jsonb_build_object('ok',true)||portal_grading_lookup(v_serial,r.id);
end $$;

create or replace function public.portal_grading_claim()
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare result jsonb;
begin
 insert into portal_grading_health(key,value) values('worker',jsonb_build_object('at',now())) on conflict(key) do update set value=excluded.value,updated_at=now();
 perform portal_grading_autolink();
 with chosen as (
  select q.id from portal_grading_outbox q where ((q.status='pending' and q.available_at<=now()) or (q.status='working' and q.lease_until<now()))
  and not exists(select 1 from portal_grading_outbox prior where prior.record_id=q.record_id and prior.revision<q.revision and prior.status not in ('synced','linked'))
  order by q.created_at for update skip locked limit 30
 ), leased as (
  update portal_grading_outbox q set status='working',attempts=attempts+1,lease_id=gen_random_uuid(),lease_until=now()+interval '5 minutes' from chosen where q.id=chosen.id returning q.*
 ) select coalesce(jsonb_agg(to_jsonb(q)||jsonb_build_object('serial',r.serial,'sheet_record_id',r.sheet_record_id,'sheet_row',r.sheet_row,'base',r.sheet_base)),'[]'::jsonb) into result from leased q join portal_grading_records r on r.id=q.record_id;
 return jsonb_build_object('ok',true,'jobs',result);
end $$;

create or replace function public.portal_grading_ack(p jsonb)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare q portal_grading_outbox;
begin
 select * into q from portal_grading_outbox where id=(p->>'id')::uuid for update;
 if not found or q.lease_id is distinct from (p->>'lease_id')::uuid or q.status<>'working' then raise exception 'Expired queue lease';end if;
 if p->>'status'='synced' then
  update portal_grading_outbox set status='synced',synced_at=now(),error=null,lease_until=null where id=q.id;
  update portal_grading_records set sheet_record_id=(p->>'sheet_record_id')::uuid,sheet_row=(p->>'row')::integer,sheet_base=p->'base' where id=q.record_id;
 elsif p->>'status'='conflict' then
  update portal_grading_outbox set status='conflict',error=left(p->>'error',500),lease_until=null where id=q.id;
  perform portal_grading_autolink();
 else
  update portal_grading_outbox set status='pending',error=left(p->>'error',500),available_at=now()+least(30,attempts)*interval '1 minute',lease_until=null where id=q.id;
 end if;
 return jsonb_build_object('ok',true);
end $$;

create or replace function public.portal_grading_import(p jsonb)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
begin
 if p ? 'devices' then
  insert into portal_grading_directory(serial,shipment,metadata,source_row)
  select x->>'serial',coalesce(x->>'shipment',''),x->'metadata',(x->>'row')::integer from jsonb_array_elements(p->'devices') x
  on conflict(serial) do update set shipment=excluded.shipment,metadata=excluded.metadata,source_row=excluded.source_row,updated_at=now()
  where portal_grading_directory.metadata is distinct from excluded.metadata or portal_grading_directory.source_row<>excluded.source_row;
 end if;
 if p ? 'records' then
  insert into portal_grading_records(id,serial,record,sheet_record_id,sheet_row,sheet_base)
  select (x->>'id')::uuid,x->>'serial',x->'record',(x->>'id')::uuid,(x->>'row')::integer,x->'base' from jsonb_array_elements(p->'records') x
  on conflict(sheet_record_id) do update set sheet_row=excluded.sheet_row,
   record=case when portal_grading_records.managed then portal_grading_records.record else excluded.record end,
   sheet_base=case when portal_grading_records.managed then portal_grading_records.sheet_base else excluded.sheet_base end,
   revision=case when not portal_grading_records.managed and portal_grading_records.record is distinct from excluded.record then portal_grading_records.revision+1 else portal_grading_records.revision end,
   serial=case when portal_grading_records.managed then portal_grading_records.serial else excluded.serial end,
   updated_at=now()
  where portal_grading_records.sheet_row is distinct from excluded.sheet_row or (not portal_grading_records.managed and (portal_grading_records.record is distinct from excluded.record or portal_grading_records.serial<>excluded.serial));
  perform portal_grading_autolink();
 end if;
 insert into portal_grading_health(key,value) values('import',jsonb_build_object('at',now())) on conflict(key) do update set value=excluded.value,updated_at=now();
 return jsonb_build_object('ok',true);
end $$;

revoke all on function public.portal_grading_autolink() from public, anon, authenticated;
grant execute on function public.portal_grading_autolink() to service_role;

-- Resolve conflicts already waiting under the same rule.
select public.portal_grading_autolink();
