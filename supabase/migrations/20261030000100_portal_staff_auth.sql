-- Staff portal: staff roster, shared terminals, badge + PIN sessions and activity log.
-- All access goes through the staff-portal edge function (service role). Nothing here is
-- readable or callable by anon/authenticated clients.

create table if not exists public.staff (
  id uuid primary key default gen_random_uuid(),
  display_name text not null unique check (length(btrim(display_name)) between 1 and 60),
  former_names text[] not null default '{}',
  role text not null default 'staff' check (role in ('staff','manager')),
  active boolean not null default true,
  badge_code text unique check (badge_code is null or badge_code ~ '^[A-Z0-9-]{3,64}$'),
  badge_registered_at timestamptz,
  pin_hash text,
  pin_set_at timestamptz,
  failed_pin_attempts integer not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
comment on table public.staff is 'GoodTech staff roster for the staff portal. display_name is the name written to Grading, Shipping and Sales records. former_names keeps earlier names (Crystal was Wei, Li was Liwei). Badge is claimed and the 4-digit PIN set on first use; pin_hash is bcrypt.';

insert into public.staff(display_name, former_names, role) values
  ('Crystal', '{Wei}', 'staff'),
  ('David', '{}', 'staff'),
  ('Fraser', '{}', 'manager'),
  ('Haobin', '{}', 'staff'),
  ('Li', '{Liwei}', 'staff'),
  ('Tallula', '{}', 'staff'),
  ('Tristan', '{}', 'staff')
on conflict (display_name) do nothing;

create table if not exists public.portal_config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
comment on table public.portal_config is 'Staff portal settings. terminal_enrol_code_hash is a bcrypt hash of the code used to enrol a shared terminal.';

create table if not exists public.portal_terminals (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 60),
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz
);

create table if not exists public.portal_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  staff_id uuid not null references public.staff(id),
  terminal_id uuid not null references public.portal_terminals(id),
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  ended_at timestamptz,
  end_reason text
);
create index if not exists portal_sessions_staff_started on public.portal_sessions(staff_id, started_at desc);

create table if not exists public.portal_activity (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  staff_id uuid references public.staff(id),
  session_id uuid references public.portal_sessions(id),
  terminal_id uuid references public.portal_terminals(id),
  module text not null,
  action text not null,
  ref text,
  outcome text not null check (outcome in ('ok','linked','error','denied')),
  details jsonb not null default '{}'::jsonb
);
create index if not exists portal_activity_staff_at on public.portal_activity(staff_id, at desc);
create index if not exists portal_activity_at on public.portal_activity(at desc);
comment on table public.portal_activity is 'Append-only log of every staff portal action with the signed-in staff member, terminal and outcome. Source for daily per-person summaries and flags.';

alter table public.staff enable row level security;
alter table public.portal_config enable row level security;
alter table public.portal_terminals enable row level security;
alter table public.portal_sessions enable row level security;
alter table public.portal_activity enable row level security;
revoke all on public.staff, public.portal_config, public.portal_terminals, public.portal_sessions, public.portal_activity from anon, authenticated;
grant select, insert, update on public.staff, public.portal_config, public.portal_terminals, public.portal_sessions to service_role;
grant select, insert on public.portal_activity to service_role;

create or replace function public.portal_token_hash(p_token text)
returns text language sql immutable set search_path = '' as $$
  select encode(extensions.digest(coalesce(p_token,''), 'sha256'), 'hex')
$$;

create or replace function public.portal_new_token()
returns text language sql volatile set search_path = '' as $$
  select encode(extensions.gen_random_bytes(32), 'hex')
$$;

create or replace function public.portal_normalise_badge(p_badge text)
returns text language sql immutable set search_path = '' as $$
  select nullif(upper(regexp_replace(coalesce(p_badge,''), '[^A-Za-z0-9-]', '', 'g')), '')
$$;

-- Rejects weak PINs: not 4 digits, all the same digit, or a straight run (1234, 4321).
create or replace function public.portal_pin_problem(p_pin text)
returns text language sql immutable set search_path = '' as $$
  select case
    when p_pin is null or p_pin !~ '^[0-9]{4}$' then 'PIN must be 4 digits.'
    when p_pin ~ '^(.)\1{3}$' then 'Choose a PIN that is not the same digit four times.'
    when p_pin in ('0123','1234','2345','3456','4567','5678','6789','9876','8765','7654','6543','5432','4321','3210') then 'Choose a PIN that is not a straight run of digits.'
    else null end
$$;

create or replace function public.portal_log(p_staff uuid, p_session uuid, p_terminal uuid, p_module text, p_action text, p_ref text, p_outcome text, p_details jsonb)
returns void language sql volatile set search_path = '' as $$
  insert into public.portal_activity(staff_id, session_id, terminal_id, module, action, ref, outcome, details)
  values (p_staff, p_session, p_terminal, left(p_module,40), left(p_action,60), left(p_ref,200), p_outcome, coalesce(p_details,'{}'::jsonb));
$$;

-- Terminal enrolment: exchanges the enrolment code for a long-lived terminal token.
create or replace function public.portal_terminal_enrol(p_code text, p_name text)
returns jsonb language plpgsql volatile set search_path = '' as $$
declare v_hash text; v_token text; v_id uuid;
begin
  select value into v_hash from public.portal_config where key = 'terminal_enrol_code_hash';
  if v_hash is null or p_code is null or extensions.crypt(p_code, v_hash) <> v_hash then
    perform pg_sleep(1);
    raise exception 'Enrolment code is not valid.';
  end if;
  if nullif(btrim(p_name),'') is null or length(p_name) > 60 then raise exception 'Enter a terminal name.'; end if;
  v_token := public.portal_new_token();
  insert into public.portal_terminals(name, token_hash) values (btrim(p_name), public.portal_token_hash(v_token)) returning id into v_id;
  perform public.portal_log(null, null, v_id, 'terminal', 'enrol', btrim(p_name), 'ok', '{}');
  return jsonb_build_object('terminalId', v_id, 'terminalToken', v_token, 'name', btrim(p_name));
end $$;

create or replace function public.portal_terminal(p_token text)
returns uuid language plpgsql volatile set search_path = '' as $$
declare v_id uuid;
begin
  update public.portal_terminals set last_seen_at = now()
   where token_hash = public.portal_token_hash(p_token) and revoked_at is null
   returning id into v_id;
  if v_id is null then raise exception 'TERMINAL: This terminal is not enrolled.'; end if;
  return v_id;
end $$;

-- Checks a PIN with lockout: 5 wrong attempts lock the account for 15 minutes.
-- Returns {ok:false,error} rather than raising so the failed attempt is committed.
create or replace function public.portal_pin_ok(p_staff uuid, p_pin text, p_terminal uuid, p_purpose text)
returns jsonb language plpgsql volatile set search_path = '' as $$
declare s public.staff; v_attempts integer;
begin
  select * into s from public.staff where id = p_staff for update;
  if not found or not s.active then return jsonb_build_object('ok', false, 'error', 'Staff member is not active.'); end if;
  if s.locked_until is not null and s.locked_until > now() then
    return jsonb_build_object('ok', false, 'error', 'PIN locked after too many attempts. Try again after '
      || to_char(s.locked_until at time zone 'Pacific/Auckland', 'HH24:MI') || ', or ask a manager to reset it.');
  end if;
  if s.pin_hash is null then return jsonb_build_object('ok', false, 'error', 'PIN has not been set.'); end if;
  if p_pin is null or p_pin !~ '^[0-9]{4}$' or extensions.crypt(p_pin, s.pin_hash) <> s.pin_hash then
    -- A lock that has run out starts a fresh count.
    v_attempts := case when s.locked_until is not null then 1 else s.failed_pin_attempts + 1 end;
    update public.staff set failed_pin_attempts = v_attempts,
      locked_until = case when v_attempts >= 5 then now() + interval '15 minutes' end,
      updated_at = now()
     where id = p_staff;
    perform public.portal_log(p_staff, null, p_terminal, 'auth', case when v_attempts >= 5 then 'pin_locked' else 'pin_failed' end,
      left(p_purpose, 60), 'denied', jsonb_build_object('attempt', v_attempts));
    return jsonb_build_object('ok', false, 'error', case when v_attempts >= 5
      then 'PIN locked after too many attempts. Try again in 15 minutes, or ask a manager to reset it.'
      else 'Wrong PIN. ' || (5 - v_attempts) || case when 5 - v_attempts = 1 then ' attempt' else ' attempts' end || ' left.' end);
  end if;
  if s.failed_pin_attempts <> 0 or s.locked_until is not null then
    update public.staff set failed_pin_attempts = 0, locked_until = null where id = p_staff;
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- Badge scan: who is this, and what does the terminal need to ask next?
create or replace function public.portal_badge(p_terminal_token text, p_badge text)
returns jsonb language plpgsql volatile set search_path = '' as $$
declare v_terminal uuid; v_badge text; s public.staff;
begin
  v_terminal := public.portal_terminal(p_terminal_token);
  v_badge := public.portal_normalise_badge(p_badge);
  if v_badge is null or length(v_badge) < 3 then raise exception 'Scan your staff badge.'; end if;
  select * into s from public.staff where badge_code = v_badge;
  if found then
    if not s.active then raise exception 'This badge belongs to an inactive staff member. Ask a manager.'; end if;
    return jsonb_build_object('state', case when s.pin_hash is null then 'set_pin' else 'pin' end,
      'staff', jsonb_build_object('id', s.id, 'name', s.display_name));
  end if;
  return jsonb_build_object('state', 'claim', 'unclaimed',
    coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', display_name) order by display_name)
                from public.staff where active and badge_code is null), '[]'::jsonb));
end $$;

-- Sign in. Known badge + PIN, known badge + new PIN (after a reset), or claim a name + new PIN on first use.
create or replace function public.portal_sign_in(p_terminal_token text, p_badge text, p_pin text, p_new_pin text, p_claim_staff uuid)
returns jsonb language plpgsql volatile set search_path = '' as $$
declare v_terminal uuid; v_badge text; s public.staff; v_token text; v_session uuid; v_problem text; v_check jsonb; v_first boolean := false;
begin
  v_terminal := public.portal_terminal(p_terminal_token);
  v_badge := public.portal_normalise_badge(p_badge);
  if v_badge is null or length(v_badge) < 3 then raise exception 'Scan your staff badge.'; end if;
  select * into s from public.staff where badge_code = v_badge for update;
  if not found then
    if p_claim_staff is null then raise exception 'Choose your name to register this badge.'; end if;
    select * into s from public.staff where id = p_claim_staff and active and badge_code is null for update;
    if not found then raise exception 'That name already has a badge. Ask a manager to reset it.'; end if;
    v_problem := public.portal_pin_problem(p_new_pin);
    if v_problem is not null then raise exception '%', v_problem; end if;
    update public.staff set badge_code = v_badge, badge_registered_at = now(), pin_hash = extensions.crypt(p_new_pin, extensions.gen_salt('bf', 8)),
      pin_set_at = now(), failed_pin_attempts = 0, locked_until = null, updated_at = now()
     where id = s.id;
    perform public.portal_log(s.id, null, v_terminal, 'auth', 'badge_registered', v_badge, 'ok', '{}');
    v_first := true;
  elsif not s.active then
    raise exception 'This badge belongs to an inactive staff member. Ask a manager.';
  elsif s.pin_hash is null then
    v_problem := public.portal_pin_problem(p_new_pin);
    if v_problem is not null then raise exception '%', v_problem; end if;
    update public.staff set pin_hash = extensions.crypt(p_new_pin, extensions.gen_salt('bf', 8)), pin_set_at = now(),
      failed_pin_attempts = 0, locked_until = null, updated_at = now() where id = s.id;
    perform public.portal_log(s.id, null, v_terminal, 'auth', 'pin_set', null, 'ok', '{}');
    v_first := true;
  else
    v_check := public.portal_pin_ok(s.id, p_pin, v_terminal, 'sign_in');
    if not (v_check->>'ok')::boolean then return v_check; end if;
  end if;
  -- One live session per person: signing in elsewhere ends the old one.
  update public.portal_sessions set ended_at = now(), end_reason = 'replaced' where staff_id = s.id and ended_at is null;
  v_token := public.portal_new_token();
  insert into public.portal_sessions(token_hash, staff_id, terminal_id) values (public.portal_token_hash(v_token), s.id, v_terminal) returning id into v_session;
  perform public.portal_log(s.id, v_session, v_terminal, 'auth', 'sign_in', null, 'ok', jsonb_build_object('first_use', v_first));
  return jsonb_build_object('ok', true, 'sessionToken', v_token, 'idleSeconds', 600,
    'staff', (select jsonb_build_object('id', id, 'name', display_name, 'role', role) from public.staff where id = s.id));
end $$;

-- Resolves the session for a request. Ends it if idle for 10 minutes.
create or replace function public.portal_session(p_terminal_token text, p_session_token text)
returns jsonb language plpgsql volatile set search_path = '' as $$
declare v_terminal uuid; x record;
begin
  v_terminal := public.portal_terminal(p_terminal_token);
  select ps.id, ps.staff_id, ps.terminal_id, ps.last_seen_at, ps.ended_at, s.display_name, s.role, s.active
    into x
    from public.portal_sessions ps join public.staff s on s.id = ps.staff_id
   where ps.token_hash = public.portal_token_hash(p_session_token)
   for update of ps;
  if not found or x.ended_at is not null or x.terminal_id <> v_terminal or not x.active then
    raise exception 'SIGNED_OUT: Signed out. Scan your badge to continue.';
  end if;
  if x.last_seen_at < now() - interval '10 minutes' then
    update public.portal_sessions set ended_at = x.last_seen_at + interval '10 minutes', end_reason = 'idle' where id = x.id;
    perform public.portal_log(x.staff_id, x.id, v_terminal, 'auth', 'sign_out', 'idle', 'ok', '{}');
    return jsonb_build_object('signedOut', true, 'reason', 'idle');
  end if;
  update public.portal_sessions set last_seen_at = now() where id = x.id;
  return jsonb_build_object('sessionId', x.id, 'terminalId', v_terminal,
    'staff', jsonb_build_object('id', x.staff_id, 'name', x.display_name, 'role', x.role));
end $$;

create or replace function public.portal_sign_out(p_session uuid, p_reason text)
returns void language plpgsql volatile set search_path = '' as $$
declare x public.portal_sessions;
begin
  update public.portal_sessions set ended_at = now(), end_reason = left(p_reason, 40)
   where id = p_session and ended_at is null returning * into x;
  if found then perform public.portal_log(x.staff_id, x.id, x.terminal_id, 'auth', 'sign_out', left(p_reason, 40), 'ok', '{}'); end if;
end $$;

-- Sweeps sessions abandoned without any further request so idle sign-outs are recorded.
create or replace function public.portal_expire_sessions()
returns integer language plpgsql volatile set search_path = '' as $$
declare n integer;
begin
  with ended as (
    update public.portal_sessions set ended_at = last_seen_at + interval '10 minutes', end_reason = 'idle'
     where ended_at is null and last_seen_at < now() - interval '10 minutes' returning *
  ), logged as (
    insert into public.portal_activity(at, staff_id, session_id, terminal_id, module, action, ref, outcome)
    select ended_at, staff_id, id, terminal_id, 'auth', 'sign_out', 'idle', 'ok' from ended returning 1
  ) select count(*) into n from logged;
  return n;
end $$;

do $$
declare f text;
begin
  foreach f in array array[
    'portal_token_hash(text)','portal_new_token()','portal_normalise_badge(text)','portal_pin_problem(text)',
    'portal_log(uuid,uuid,uuid,text,text,text,text,jsonb)','portal_terminal_enrol(text,text)','portal_terminal(text)',
    'portal_pin_ok(uuid,text,uuid,text)','portal_badge(text,text)',
    'portal_sign_in(text,text,text,text,uuid)','portal_session(text,text)','portal_sign_out(uuid,text)','portal_expire_sessions()'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

select cron.schedule('portal-expire-sessions', '*/5 * * * *', $$select public.portal_expire_sessions()$$);
