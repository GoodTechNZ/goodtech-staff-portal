-- Product-code changes from the portal (managers, with PIN):
--   kind 'device': one graded IMEI moves to another SKU (grade, colour or model correction).
--   kind 'stock':  a quantity of stock moves from one SKU to another at one Cin7 location.
-- Cin7 is changed with a stock adjustment (source on-hand minus N, target plus N, at the source's
-- average cost), reviewed against live balances first, the same method as the 15 Oct correction.
-- For a device, the Grading row's grade and colour are then written by the normal sheet worker,
-- and the ASNs Code (column AE) is checked/updated by the ASNs DB script (AsnOpsSync.gs).
--
-- States: preview → reserved → creating → draft → completing → cin7_done
--         → sheet (device: waiting for the sheets) → done.   'review' = stopped, needs a person.

create table if not exists public.portal_code_changes (
  id uuid primary key,
  kind text not null check (kind in ('device', 'stock')),
  serial text,
  record_id uuid references public.portal_grading_records(id),
  record_version bigint,
  from_sku text not null,
  to_sku text not null,
  quantity integer not null check (quantity between 1 and 500),
  location text not null,
  reason text not null,
  staff_id uuid not null references public.staff(id),
  staff_name text not null,
  state text not null default 'preview'
    check (state in ('preview', 'reserved', 'creating', 'draft', 'completing', 'cin7_done', 'sheet', 'done', 'review')),
  plan jsonb not null,
  task_id text,
  adjustment_number text,
  outbox_id uuid,
  sheet_result jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (kind = 'stock' or (serial is not null and record_id is not null and quantity = 1))
);
create index if not exists portal_code_changes_active on public.portal_code_changes(state) where state not in ('preview', 'done');
alter table public.portal_code_changes enable row level security;
revoke all on public.portal_code_changes from anon, authenticated;
grant select, insert, update on public.portal_code_changes to service_role;

create or replace function public.portal_code_cin7_location(p_loc text)
returns text language sql immutable as $$
  select case
    when lower(coalesce(p_loc, '')) ~ '^(cabinet|ready for sale)' then 'Ready For Sale'
    when lower(coalesce(p_loc, '')) ~ '^repair' then 'Repairs'
    when lower(coalesce(p_loc, '')) ~ 'lock' then 'Locked Devices'
    else null end;
$$;

-- Everything the gateway needs to review a device change, with the reasons it can't go ahead.
create or replace function public.portal_code_device_context(p_serial text, p_record uuid)
returns jsonb language plpgsql stable set search_path = public, pg_temp as $$
declare r portal_grading_records; g grading_sheet_current; po text; problems text[] := '{}'; active jsonb; sku text;
begin
  select * into r from portal_grading_records where id = p_record and serial = p_serial and linked_record_id is null;
  if not found then raise exception 'Scan the device again.'; end if;
  if coalesce(r.record->>'grade', '') = '' then raise exception 'This device has not been graded yet.'; end if;
  select * into g from grading_sheet_current where record_id = coalesce(r.sheet_record_id, r.id) and not missing_from_sheet limit 1;
  if not found then
    select * into g from grading_sheet_current where serial_number = p_serial and not missing_from_sheet order by source_row desc limit 1;
  end if;
  sku := nullif(btrim(coalesce(g.product_code_raw, '')), '');
  if sku is null or sku !~ '^[A-Z0-9][A-Z0-9-]+$' then problems := array_append(problems, 'The Grading sheet has no product code for this device yet (ASNs column AE).'::text); end if;
  po := substring(coalesce(g.po_raw, '') from 'PO\d+');
  if po is null then problems := array_append(problems, 'This device has no PO yet. Correct the grade before it is received, or receive it first.'::text); end if;
  if exists (select 1 from portal_grading_outbox where record_id = r.id and status in ('pending', 'working', 'conflict')) then
    problems := array_append(problems, 'An earlier change to this device has not reached the sheet yet (or has a conflict).'::text);
  end if;
  if exists (select 1 from imei_lifecycle_events where imei = p_serial and event_type = 'SHIPPED') then
    problems := array_append(problems, 'This IMEI has a shipping record. Confirm it was returned before changing its stock.'::text);
  end if;
  select to_jsonb(c) into active from portal_code_changes c where c.record_id = r.id and c.state not in ('preview', 'done') limit 1;
  if active is not null then problems := array_append(problems, 'A product-code change for this device is already ' || (active->>'state') || '.'); end if;
  return jsonb_build_object(
    'recordId', r.id, 'version', r.revision, 'serial', p_serial, 'sheetRow', coalesce(g.source_row, r.sheet_row),
    'sku', sku, 'po', po, 'grade', r.record->>'grade', 'colour', r.record->>'colour',
    'location', public.portal_code_cin7_location(coalesce(nullif(r.record->>'destination', ''), r.record->>'location')),
    'purchaseId', (select cin7_purchase_id from cin7_purchases_raw where summary->>'OrderNumber' = po limit 1),
    'problems', to_jsonb(problems));
end $$;

create or replace function public.portal_code_prepare(p jsonb)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare c portal_code_changes;
begin
  if length(btrim(coalesce(p->>'reason', ''))) = 0 or length(p->>'reason') > 300 then raise exception 'Enter a reason (up to 300 characters).'; end if;
  insert into portal_code_changes(id, kind, serial, record_id, record_version, from_sku, to_sku, quantity, location, reason, staff_id, staff_name, plan)
  values ((p->>'id')::uuid, p->>'kind', nullif(p->>'serial', ''), nullif(p->>'recordId', '')::uuid, nullif(p->>'version', '')::bigint,
          p#>>'{plan,source,SKU}', p#>>'{plan,target,SKU}', (p->>'quantity')::integer, p#>>'{plan,location}', btrim(p->>'reason'),
          (p->>'staffId')::uuid, p->>'staffName', p->'plan')
  on conflict (id) do nothing;
  select * into c from portal_code_changes where id = (p->>'id')::uuid;
  if c.staff_id <> (p->>'staffId')::uuid or c.to_sku <> p#>>'{plan,target,SKU}' then raise exception 'Change identifier already used.'; end if;
  return to_jsonb(c);
end $$;

-- State machine for a change. Each step is checked so a retry never repeats a Cin7 write.
create or replace function public.portal_code_job(p jsonb)
returns jsonb language plpgsql set search_path = public, pg_temp as $$
declare c portal_code_changes; r portal_grading_records; act text := p->>'action'; rec jsonb; sid uuid;
begin
  select * into c from portal_code_changes where id = (p->>'id')::uuid for update;
  if not found then raise exception 'Change not found.'; end if;
  if act = 'get' then return to_jsonb(c); end if;
  if act = 'reserve' then
    if c.state <> 'preview' then return to_jsonb(c); end if;
    if c.created_at < now() - interval '10 minutes' then raise exception 'This review is more than 10 minutes old. Start again.'; end if;
    perform pg_advisory_xact_lock(hashtext('portal-code-change'));
    if exists (select 1 from portal_code_changes x where x.id <> c.id and x.state not in ('preview', 'done')
                and (x.from_sku in (c.from_sku, c.to_sku) or x.to_sku in (c.from_sku, c.to_sku) or (c.serial is not null and x.serial = c.serial)))
       or exists (select 1 from operations.device_product_changes x where x.state not in ('preview', 'done')
                and (x.from_sku in (c.from_sku, c.to_sku) or x.to_sku in (c.from_sku, c.to_sku))) then
      raise exception 'Another product-code change is in progress for one of these SKUs. Wait for it to finish.';
    end if;
    if c.kind = 'device' then
      perform pg_advisory_xact_lock(hashtext('portal-grading:' || c.serial));
      select * into r from portal_grading_records where id = c.record_id for update;
      if r.revision <> c.record_version or r.serial <> c.serial then raise exception 'The device changed since the review. Scan again.'; end if;
      if exists (select 1 from portal_grading_outbox where record_id = r.id and status in ('pending', 'working', 'conflict')) then
        raise exception 'An earlier change to this device has not reached the sheet yet.';
      end if;
    end if;
    update portal_code_changes set state = 'reserved', updated_at = now() where id = c.id returning * into c;
    return to_jsonb(c);
  end if;
  if act = 'transition' then
    if c.state is distinct from p->>'expected' then raise exception 'This change is already being processed. Refresh its status.'; end if;
    if (c.state, p->>'next') not in (('reserved','creating'),('creating','draft'),('draft','completing'),('completing','cin7_done'),
                                     ('reserved','review'),('creating','review'),('draft','review'),('completing','review')) then
      raise exception 'Invalid change step.';
    end if;
    update portal_code_changes set state = p->>'next', task_id = coalesce(p->>'taskId', task_id),
           adjustment_number = coalesce(p->>'adjustmentNumber', adjustment_number), error = p->>'error', updated_at = now()
     where id = c.id returning * into c;
    if c.state <> 'cin7_done' then return to_jsonb(c); end if;
    if c.kind = 'stock' then
      update portal_code_changes set state = 'done', updated_at = now() where id = c.id returning * into c;
      return to_jsonb(c);
    end if;
    -- Device: queue the Grading row update (grade and colour of the new product) for the sheet worker.
    perform pg_advisory_xact_lock(hashtext('portal-grading:' || c.serial));
    select * into r from portal_grading_records where id = c.record_id for update;
    rec := r.record || jsonb_build_object('grade', c.plan#>>'{target,grade}', 'colour', coalesce(nullif(c.plan#>>'{target,colour}', ''), r.record->>'colour'));
    sid := gen_random_uuid();
    update portal_grading_records set record = rec, revision = revision + 1, managed = true, updated_at = now() where id = r.id returning * into r;
    insert into portal_grading_outbox(id, record_id, revision, payload, owner_id) values (sid, r.id, r.revision, rec, c.staff_id::text);
    update portal_code_changes set state = 'sheet', outbox_id = sid, updated_at = now() where id = c.id returning * into c;
    return to_jsonb(c);
  end if;
  raise exception 'Unknown change action.';
end $$;

-- Device changes whose Grading row is written: ASNs DB should now check the Code column.
-- A Grading conflict stops the change for review (Cin7 is already correct).
create or replace function public.portal_code_sheet_pending()
returns jsonb language plpgsql set search_path = public, pg_temp as $$
begin
  update portal_code_changes c set state = 'review', updated_at = now(),
         error = 'Cin7 is updated, but the Grading sheet row could not be written: ' || coalesce(q.error, 'conflict') || '. Update grade/colour in the sheet by hand.'
    from portal_grading_outbox q
   where q.id = c.outbox_id and c.state = 'sheet' and q.status in ('conflict', 'dismissed');
  return coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'serial', c.serial, 'from', c.from_sku, 'to', c.to_sku))
                     from portal_code_changes c join portal_grading_outbox q on q.id = c.outbox_id
                    where c.state = 'sheet' and q.status in ('synced', 'linked')), '[]'::jsonb);
end $$;

create or replace function public.portal_code_sheet_ack(p jsonb)
returns integer language plpgsql set search_path = public, pg_temp as $$
declare x jsonb; n integer := 0;
begin
  for x in select * from jsonb_array_elements(coalesce(p->'results', '[]'::jsonb)) loop
    update portal_code_changes set
      state = case when (x->>'ok')::boolean then 'done' else 'review' end,
      sheet_result = x, error = case when (x->>'ok')::boolean then null else left(coalesce(x->>'error', 'ASNs code not updated'), 500) end,
      updated_at = now()
     where id = (x->>'id')::uuid and state = 'sheet';
    if found then n := n + 1; end if;
  end loop;
  return n;
end $$;

create or replace function public.portal_code_recent(p_limit integer default 20)
returns jsonb language sql stable set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(x order by x.created_at desc), '[]'::jsonb) from (
    select id, kind, serial, from_sku, to_sku, quantity, location, reason, staff_name, state, adjustment_number, error, created_at, updated_at
      from portal_code_changes where state <> 'preview' order by created_at desc limit least(greatest(p_limit, 1), 100)) x;
$$;

-- A device in the middle of a code change can't be moved until the change finishes. (A check in the
-- move function, not a trigger, so the sheet import can never be blocked by it.)
do $$
declare d text := pg_get_functiondef('public.portal_grading_move(jsonb)'::regprocedure);
  anchor text := 'if coalesce(r.record->>''grade'','''')='''' then raise exception ''This device has not been graded yet.'';end if;';
begin
  if position('portal_code_changes' in d) = 0 then
    if position(anchor in d) = 0 then raise exception 'portal_grading_move patch anchor not found'; end if;
    d := replace(d, anchor, anchor || E'\n if exists(select 1 from portal_code_changes where record_id=r.id and state in (''reserved'',''creating'',''draft'',''completing'',''cin7_done'')) then raise exception ''A product-code change is in progress for this device. Try again in a minute.'';end if;');
    execute d;
  end if;
end $$;

do $$
declare f text;
begin
  foreach f in array array['portal_code_device_context(text, uuid)', 'portal_code_prepare(jsonb)', 'portal_code_job(jsonb)',
                           'portal_code_sheet_pending()', 'portal_code_sheet_ack(jsonb)', 'portal_code_recent(integer)', 'portal_code_cin7_location(text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
