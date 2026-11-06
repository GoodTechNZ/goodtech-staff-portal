-- Grading sheet import had been failing since 5 Nov 05:44 UTC with
-- "duplicate key value violates unique constraint portal_grading_records_pkey".
-- Cause: the worker appended a portal record to the sheet (the row carries the portal record's id)
-- but the save was then marked as a conflict, so the portal record never got sheet_record_id.
-- The import matches on sheet_record_id, so it tried to insert that id again and the whole batch failed.
-- Fix: the import first adopts such rows (sets sheet_record_id = id) so they update instead.

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
  -- Rows the worker wrote whose save was never acknowledged: link the sheet row to its portal record.
  update portal_grading_records r set sheet_record_id = r.id, updated_at = now()
    from jsonb_array_elements(p->'records') x
   where r.id = (x->>'id')::uuid and r.sheet_record_id is null;
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

-- 353887196803749: in the sheet at row 35666 (same values as the waiting save); clear its stuck saves.
do $$
begin
  if exists (select 1 from portal_grading_records where id = 'bdb46367-0194-4bd3-80a6-aea4e02fbe23' and serial = '353887196803749') then
    perform portal_grading_dismiss('bdb46367-0194-4bd3-80a6-aea4e02fbe23', 'Duplicate: already in the sheet at row 35666');
    update portal_grading_records set sheet_record_id = id, sheet_row = 35666
     where id = 'bdb46367-0194-4bd3-80a6-aea4e02fbe23' and sheet_record_id is null;
  end if;
end $$;
