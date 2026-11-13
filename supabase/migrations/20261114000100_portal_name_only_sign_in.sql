-- No PINs for everyday use: staff sign in (and switch user) by picking their name. A PIN is asked only to
-- unlock Admin and Sales & Ops (managers): the session is "elevated" until it ends (sign-out, switching
-- user, or 5 minutes idle), and the gateway / Sales & Ops function refuse those areas until it is. A manager on
-- their own device (portal_config.pinless_terminals) counts as unlocked.
alter table public.portal_sessions add column if not exists elevated_at timestamptz;

create or replace function public.portal_staff_list(p_terminal_token text)
returns jsonb language plpgsql set search_path = '' as $function$
begin
  perform public.portal_terminal(p_terminal_token);
  return coalesce((select jsonb_agg(jsonb_build_object('id', id, 'name', display_name, 'hasPin', pin_hash is not null, 'noPin', true) order by display_name)
                     from public.staff where active), '[]'::jsonb);
end $function$;

create or replace function public.portal_sign_in_staff(p_terminal_token text, p_staff uuid, p_pin text, p_new_pin text)
returns jsonb language plpgsql set search_path = '' as $function$
declare v_terminal uuid; s public.staff; v_token text; v_session uuid;
begin
  v_terminal := public.portal_terminal(p_terminal_token);
  select * into s from public.staff where id = p_staff;
  if not found or not s.active then raise exception 'Choose your name.'; end if;
  -- One live session per person: signing in elsewhere ends the old one.
  update public.portal_sessions set ended_at = now(), end_reason = 'replaced' where staff_id = s.id and ended_at is null;
  v_token := public.portal_new_token();
  insert into public.portal_sessions(token_hash, staff_id, terminal_id) values (public.portal_token_hash(v_token), s.id, v_terminal) returning id into v_session;
  perform public.portal_log(s.id, v_session, v_terminal, 'auth', 'sign_in', null, 'ok', jsonb_build_object('pin', false));
  return jsonb_build_object('ok', true, 'sessionToken', v_token, 'idleSeconds', 300,
    'staff', jsonb_build_object('id', s.id, 'name', s.display_name, 'role', s.role,
      'elevated', s.role = 'manager' and public.portal_pinless(v_terminal, s.id)));
end $function$;

create or replace function public.portal_session(p_terminal_token text, p_session_token text)
returns jsonb language plpgsql set search_path = '' as $function$
declare v_terminal uuid; x record;
begin
  v_terminal := public.portal_terminal(p_terminal_token);
  select ps.id, ps.staff_id, ps.terminal_id, ps.last_seen_at, ps.ended_at, ps.elevated_at, s.display_name, s.role, s.active
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
                                'elevated', x.role = 'manager' and (x.elevated_at is not null or public.portal_pinless(v_terminal, x.staff_id))));
end $function$;

-- Unlock Admin / Sales & Ops for this session with the manager's PIN (lockout rules of portal_pin_ok).
create or replace function public.portal_session_elevate(p_session uuid, p_pin text)
returns jsonb language plpgsql set search_path = '' as $function$
declare x record; v_check jsonb;
begin
  select ps.id, ps.staff_id, ps.terminal_id, s.role into x
    from public.portal_sessions ps join public.staff s on s.id = ps.staff_id
   where ps.id = p_session and ps.ended_at is null;
  if not found then return jsonb_build_object('ok', false, 'error', 'Signed out. Choose your name to continue.'); end if;
  if x.role <> 'manager' then return jsonb_build_object('ok', false, 'error', 'Managers only.'); end if;
  v_check := public.portal_pin_ok(x.staff_id, p_pin, x.terminal_id, 'unlock');
  if not (v_check->>'ok')::boolean then return v_check; end if;
  update public.portal_sessions set elevated_at = now() where id = x.id;
  perform public.portal_log(x.staff_id, x.id, x.terminal_id, 'auth', 'unlock', null, 'ok', '{}');
  return jsonb_build_object('ok', true);
end $function$;
revoke all on function public.portal_session_elevate(uuid, text) from public, anon, authenticated;
grant execute on function public.portal_session_elevate(uuid, text) to service_role;
