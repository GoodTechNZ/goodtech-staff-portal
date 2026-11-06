-- A device is graded once. After that, staff can move it (Ready For Sale / Repairs / Locked) and
-- update its status note, but not grade it again. Grade, colour and model changes are product-code
-- changes that move stock in Cin7, so they go through the product-code change process instead.

-- The newest graded row for a serial in the live sheet copy (grading_sheet_current is refreshed
-- from the Grading tab every few minutes, ahead of the portal's own record import).
create or replace function public.portal_grading_sheet_row(p_serial text)
returns jsonb language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object('row', source_row, 'grade', btrim(grade_raw), 'colour', colour, 'status', status_raw,
                            'location', location_raw, 'tester', tester_code, 'productCode', product_code_raw, 'recordId', record_id)
    from grading_sheet_current
   where serial_number = p_serial and not missing_from_sheet and btrim(coalesce(grade_raw, '')) <> ''
   order by source_row desc limit 1;
$$;

-- Lookup for the Grading screen: the usual lookup plus whether the device is already graded.
create or replace function public.portal_grading_scan(p_serial text, p_id uuid default null)
returns jsonb language plpgsql stable set search_path = public, pg_temp as $$
declare d jsonb; sheet jsonb; blocked boolean := false; rid uuid;
begin
  d := portal_grading_lookup(p_serial, p_id);
  if coalesce((d->>'needsSelection')::boolean, false) then return d; end if;
  rid := nullif(d#>>'{device,recordId}', '')::uuid;
  sheet := portal_grading_sheet_row(p_serial);
  if rid is not null then
    blocked := exists (select 1 from portal_grading_outbox where record_id = rid and status in ('pending', 'working', 'conflict'));
  end if;
  return d || jsonb_build_object(
    'graded', (rid is not null and coalesce(d#>>'{record,grade}', '') <> '') or sheet is not null,
    'sheet', sheet,
    'canMove', rid is not null and not blocked);
end $$;

create or replace function public.portal_grading_save(p jsonb)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare r portal_grading_records; q portal_grading_outbox; rid uuid; sid uuid; v_serial text; rec jsonb; t text; v text; existing portal_grading_records; sheet jsonb;
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
 rid:=nullif(p->>'recordId','')::uuid;
 -- Graded once only. Moves and status changes use portal_grading_move.
 select * into existing from portal_grading_records where serial=v_serial and linked_record_id is null
  order by (record->>'grade' is not null and record->>'grade'<>'') desc, sheet_row desc nulls last limit 1;
 if rid is not null or existing.id is not null then
  raise exception 'Already graded%as grade % by %. Scan it again to move it or change its status.',
   coalesce(' (sheet row '||existing.sheet_row||') ',' '), coalesce(nullif(existing.record->>'grade',''),'?'), coalesce(nullif(existing.record->>'tester',''),'another tester');
 end if;
 sheet:=portal_grading_sheet_row(v_serial);
 if sheet is not null then
  raise exception 'Already graded in the sheet (row %) as grade % by %. It can be moved once the sheet import picks it up.',
   sheet->>'row', sheet->>'grade', coalesce(nullif(sheet->>'tester',''),'another tester');
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
 perform portal_grading_lookup(v_serial,null);
 if p->>'version' is distinct from '0' then raise exception 'Record changed. Scan again.';end if;
 insert into portal_grading_records(serial,record,managed) values(v_serial,rec||jsonb_build_object('testedAt',now()),true) returning * into r;
 insert into portal_grading_outbox(id,record_id,revision,payload,owner_id) values(sid,r.id,r.revision,rec,p->>'owner');
 return jsonb_build_object('ok',true)||portal_grading_lookup(v_serial,r.id);
end $$;

-- Move a graded device and/or update its status note. Grade, colour, tests and tester stay as graded.
create or replace function public.portal_grading_move(p jsonb)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare r portal_grading_records; q portal_grading_outbox; sid uuid; v_serial text; dest text; loc text; st text; nt text; rec jsonb; from_loc text;
begin
 v_serial:=p->>'serial'; sid:=(p->>'moveId')::uuid; dest:=p->>'destination';
 st:=coalesce(p->>'status',''); nt:=p->>'notes';
 if v_serial is null or v_serial !~ '^[A-Za-z0-9-]{5,30}$' or sid is null or nullif(p->>'owner','') is null or nullif(p->>'staff','') is null then raise exception 'Invalid request. Scan again.';end if;
 if dest not in ('Ready For Sale','Repairs','Locked') then raise exception 'Choose where the device is going';end if;
 if length(st)>1000 or (nt is not null and length(nt)>5000) then raise exception 'Status or notes are too long';end if;
 loc:=case dest when 'Ready For Sale' then 'Cabinet' else dest end;
 perform pg_advisory_xact_lock(hashtext('portal-grading:'||v_serial));
 select * into q from portal_grading_outbox where id=sid;
 if found then
  if q.owner_id<>p->>'owner' or (select x.serial from portal_grading_records x where x.id=q.record_id)<>v_serial then raise exception 'Request identifier already used';end if;
  return jsonb_build_object('ok',true,'alreadyRecorded',true)||portal_grading_scan(v_serial,q.record_id);
 end if;
 select * into r from portal_grading_records where id=(p->>'recordId')::uuid and serial=v_serial and linked_record_id is null for update;
 if not found or r.revision::text is distinct from p->>'version' then raise exception 'This device changed since you scanned it. Scan again.';end if;
 if coalesce(r.record->>'grade','')='' then raise exception 'This device has not been graded yet.';end if;
 if exists(select 1 from portal_grading_outbox where record_id=r.id and status in ('pending','working','conflict')) then
  raise exception 'An earlier change to this device has not reached the sheet yet (or has a conflict). Ask Fraser to clear it first.';
 end if;
 from_loc:=coalesce(r.record->>'location','');
 if dest=coalesce(r.record->>'destination','') and loc=from_loc and st=coalesce(r.record->>'status','') and (nt is null or nt=coalesce(r.record->>'notes','')) then
  raise exception 'Nothing has changed.';
 end if;
 if exists(select 1 from jsonb_each_text(coalesce(r.record->'tests','{}'::jsonb)) where value='Fail') and dest='Ready For Sale' and btrim(st)='' then
  raise exception 'This device failed a test. Add a status note before moving it to Ready For Sale.';
 end if;
 rec:=r.record||jsonb_build_object('destination',dest,'location',loc,'status',st)||case when nt is null then '{}'::jsonb else jsonb_build_object('notes',nt) end;
 update portal_grading_records set record=rec,revision=revision+1,managed=true,updated_at=now() where id=r.id returning * into r;
 insert into portal_grading_outbox(id,record_id,revision,payload,owner_id) values(sid,r.id,r.revision,rec,p->>'owner');
 if loc<>from_loc then
  insert into operations.device_transfers(id,serial,record_id,from_location,to_location,staff,owner_id,reason,outbox_id)
  values(sid,r.serial,r.id,from_loc,loc,p->>'staff',p->>'owner',coalesce(nullif(btrim(st),''),'Moved in staff portal'),sid);
 end if;
 return jsonb_build_object('ok',true,'from',from_loc,'to',loc)||portal_grading_scan(v_serial,r.id);
end $$;

revoke all on function public.portal_grading_sheet_row(text) from public, anon, authenticated;
revoke all on function public.portal_grading_scan(text, uuid) from public, anon, authenticated;
revoke all on function public.portal_grading_move(jsonb) from public, anon, authenticated;
grant execute on function public.portal_grading_sheet_row(text) to service_role;
grant execute on function public.portal_grading_scan(text, uuid) to service_role;
grant execute on function public.portal_grading_move(jsonb) to service_role;
