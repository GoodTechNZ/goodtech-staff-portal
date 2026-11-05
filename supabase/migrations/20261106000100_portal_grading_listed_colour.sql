-- Grading colour: only ask for a colour when the supplier hasn't listed one.
--
-- * portal_grading_colour now also treats '#N/A' and 'N/A' as blank (as well as 'X' and '*').
-- * portal_grading_listed_colour(colour, supplier) returns the directory colour, or else the colour
--   parsed from the supplier description: the segment after the storage size, e.g.
--     APPL.iPhone 13 mini.A2626.128GB.Midnight.UNL.A+          -> Midnight
--     Apple / iPhone 13 / A2631 / 128GB / Green / Unlocked / … -> Green
--     SAMS.Galaxy Watch7.SM-L305U.40mm.Aluminum.32GB.X.OTH...  -> '' (X = not listed)
-- * portal_grading_lookup returns device.listedColour. The screen shows it with a Change button and
--   only requires a typed colour when it is blank.

create or replace function public.portal_grading_colour(value text)
returns text language sql immutable set search_path to 'pg_catalog' as $function$
 select case when upper(cleaned) in ('X','#N/A','N/A') then '' else cleaned end
 from (select btrim(regexp_replace(coalesce(value,''),'^[[:space:]*]+','','g')) cleaned) s;
$function$;

create or replace function public.portal_grading_listed_colour(p_colour text, p_supplier text)
returns text language plpgsql immutable set search_path to 'public', 'pg_catalog' as $function$
declare c text := public.portal_grading_colour(p_colour); parts text[]; i integer;
begin
 if c<>'' then return c; end if;
 if coalesce(p_supplier,'')='' then return ''; end if;
 parts := case when p_supplier like '% / %' then string_to_array(p_supplier,' / ') else string_to_array(p_supplier,'.') end;
 for i in 3..coalesce(array_length(parts,1),0)-1 loop
  if btrim(parts[i]) ~* '^\d+\s?(GB|TB)$' then return left(public.portal_grading_colour(parts[i+1]),150); end if;
 end loop;
 return '';
end $function$;

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
 d:=coalesce(d,'{}'::jsonb);
 d:=d||jsonb_build_object('colour',public.portal_grading_listed_colour(d->>'colour',d->>'supplier'));
 d:=d||jsonb_build_object('listedColour',d->>'colour');
 if r.record is not null then r.record:=jsonb_set(r.record,'{colour}',to_jsonb(public.portal_grading_colour(r.record->>'colour')));end if;
 return jsonb_build_object('device',coalesce(d,'{}'::jsonb)||jsonb_build_object('serial',p_serial,'recordId',r.id,'version',coalesce(r.revision,0)::text,'row',r.sheet_row,'model',coalesce(nullif(d->>'model',''),'Device')),
 'record',coalesce(r.record,jsonb_build_object('grade','','colour',coalesce(d->>'colour',''),'status','','location','','tester','','date','','battery','','tests','{}'::jsonb,'notes','','testedAt','','destination','')),
 'sync',coalesce(state,'synced'));
end $$;
