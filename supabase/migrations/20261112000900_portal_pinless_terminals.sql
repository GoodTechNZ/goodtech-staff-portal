-- No PIN for a named person on their own, unshared devices (Fraser's 17 Pro, MacBook and Home PC).
-- portal_config 'pinless_terminals' = {"<terminal id>": "<staff id>"}. On a listed terminal, only the
-- listed person signs in with a tap (no PIN pad) and skips the "PIN again" step on sensitive actions
-- (the screens show a Confirm/Cancel dialog instead). Everyone else on that terminal, and that person
-- on any other terminal, still uses their PIN. The 5-minute idle sign-out is unchanged.

insert into public.portal_config(key, value) values ('pinless_terminals', jsonb_build_object(
  '1eeec859-1ca5-4351-8edf-a44cb8b6838e', '94f1ebc8-ab5b-47b4-b6a1-3eb5358617e0',   -- Fraser's MacBook
  '80cdbf3d-6578-4538-8c3f-331505e44e8f', '94f1ebc8-ab5b-47b4-b6a1-3eb5358617e0',   -- Fraser's 17 Pro
  '25fb5cd9-cf75-4c46-a371-2753848cb729', '94f1ebc8-ab5b-47b4-b6a1-3eb5358617e0'    -- Fraser Home PC
)::text)
on conflict (key) do update set value = excluded.value;

create or replace function public.portal_pinless(p_terminal uuid, p_staff uuid)
returns boolean language sql stable set search_path = '' as $$
  select coalesce((select (value::jsonb ->> p_terminal::text) = p_staff::text
                     from public.portal_config where key = 'pinless_terminals'), false)
     and exists (select 1 from public.portal_terminals t where t.id = p_terminal and t.revoked_at is null);
$$;
revoke all on function public.portal_pinless(uuid, uuid) from public, anon, authenticated;
grant execute on function public.portal_pinless(uuid, uuid) to service_role;

create or replace function public.portal_staff_list(p_terminal_token text)
returns jsonb language plpgsql set search_path = '' as $function$
declare v_terminal uuid;
begin
  v_terminal := public.portal_terminal(p_terminal_token);
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', display_name, 'hasPin', pin_hash is not null,
                                                       'noPin', public.portal_pinless(v_terminal, id)) order by display_name)
                     from public.staff where active), '[]'::jsonb);
end $function$;

create or replace function public.portal_sign_in_staff(p_terminal_token text, p_staff uuid, p_pin text, p_new_pin text)
returns jsonb language plpgsql set search_path = '' as $function$
declare v_terminal uuid; s public.staff; v_token text; v_session uuid; v_problem text; v_check jsonb; v_first boolean := false; v_pinless boolean;
begin
  v_terminal := public.portal_terminal(p_terminal_token);
  select * into s from public.staff where id = p_staff for update;
  if not found or not s.active then raise exception 'Choose your name.'; end if;
  v_pinless := public.portal_pinless(v_terminal, s.id);
  if v_pinless then
    null;  -- this person's own device: no PIN
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
  perform public.portal_log(s.id, v_session, v_terminal, 'auth', 'sign_in', null, 'ok', jsonb_build_object('first_use', v_first, 'pinless', v_pinless));
  return jsonb_build_object('ok', true, 'sessionToken', v_token, 'idleSeconds', 300,
    'staff', (select jsonb_build_object('id', id, 'name', display_name, 'role', role, 'pinless', v_pinless) from public.staff where id = s.id));
end $function$;

create or replace function public.portal_session(p_terminal_token text, p_session_token text)
returns jsonb language plpgsql set search_path = '' as $function$
declare v_terminal uuid; x record;
begin
  v_terminal := public.portal_terminal(p_terminal_token);
  select ps.id, ps.staff_id, ps.terminal_id, ps.last_seen_at, ps.ended_at, s.display_name, s.role, s.active
    into x
    from public.portal_sessions ps join public.staff s on s.id = ps.staff_id
   where ps.token_hash = public.portal_token_hash(p_session_token)
   for update of ps;
  if not found or x.ended_at is not null or x.terminal_id <> v_terminal or not x.active then
    raise exception 'SIGNED_OUT: Signed out. Choose your name to continue.';
  end if;
  if x.last_seen_at < now() - interval '5 minutes' then
    update public.portal_sessions set ended_at = x.last_seen_at + interval '5 minutes', end_reason = 'idle' where id = x.id;
    perform public.portal_log(x.staff_id, x.id, v_terminal, 'auth', 'sign_out', 'idle', 'ok', '{}');
    return jsonb_build_object('signedOut', true, 'reason', 'idle');
  end if;
  update public.portal_sessions set last_seen_at = now() where id = x.id;
  return jsonb_build_object('sessionId', x.id, 'terminalId', v_terminal,
    'staff', jsonb_build_object('id', x.staff_id, 'name', x.display_name, 'role', x.role,
                                'pinless', public.portal_pinless(v_terminal, x.staff_id)));
end $function$;
