-- Idle sign-out after 5 minutes (was 10). Completing a device or order no longer ends the session;
-- people stay signed in until they sign out or go idle.

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
    raise exception 'SIGNED_OUT: Signed out. Choose your name to continue.';
  end if;
  if x.last_seen_at < now() - interval '5 minutes' then
    update public.portal_sessions set ended_at = x.last_seen_at + interval '5 minutes', end_reason = 'idle' where id = x.id;
    perform public.portal_log(x.staff_id, x.id, v_terminal, 'auth', 'sign_out', 'idle', 'ok', '{}');
    return jsonb_build_object('signedOut', true, 'reason', 'idle');
  end if;
  update public.portal_sessions set last_seen_at = now() where id = x.id;
  return jsonb_build_object('sessionId', x.id, 'terminalId', v_terminal,
    'staff', jsonb_build_object('id', x.staff_id, 'name', x.display_name, 'role', x.role));
end $$;

create or replace function public.portal_expire_sessions()
returns integer language plpgsql volatile set search_path = '' as $$
declare n integer;
begin
  with ended as (
    update public.portal_sessions set ended_at = last_seen_at + interval '5 minutes', end_reason = 'idle'
     where ended_at is null and last_seen_at < now() - interval '5 minutes' returning *
  ), logged as (
    insert into public.portal_activity(at, staff_id, session_id, terminal_id, module, action, ref, outcome)
    select ended_at, staff_id, id, terminal_id, 'auth', 'sign_out', 'idle', 'ok' from ended returning 1
  ) select count(*) into n from logged;
  return n;
end $$;

create or replace function public.portal_sign_in_staff(p_terminal_token text, p_staff uuid, p_pin text, p_new_pin text)
returns jsonb language plpgsql volatile set search_path = '' as $$
declare v_terminal uuid; s public.staff; v_token text; v_session uuid; v_problem text; v_check jsonb; v_first boolean := false;
begin
  v_terminal := public.portal_terminal(p_terminal_token);
  select * into s from public.staff where id = p_staff for update;
  if not found or not s.active then raise exception 'Choose your name.'; end if;
  if s.pin_hash is null then
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
  return jsonb_build_object('ok', true, 'sessionToken', v_token, 'idleSeconds', 300,
    'staff', (select jsonb_build_object('id', id, 'name', display_name, 'role', role) from public.staff where id = s.id));
end $$;

create or replace function public.portal_health()
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'grading', jsonb_build_object(
      'pending', (select count(*) from public.portal_grading_outbox where status in ('pending','working')),
      'oldestPendingAt', (select min(created_at) from public.portal_grading_outbox where status in ('pending','working')),
      'conflicts', (select count(*) from public.portal_grading_outbox where status = 'conflict'),
      'linkedToday', (select count(*) from public.portal_grading_outbox where status = 'linked' and synced_at >= (((now() at time zone 'Pacific/Auckland')::date)::timestamp at time zone 'Pacific/Auckland')),
      'workerAt', (select value->>'at' from public.portal_grading_health where key = 'worker'),
      'importAt', (select value->>'at' from public.portal_grading_health where key = 'import')),
    'sessions', jsonb_build_object(
      'active', (select count(*) from public.portal_sessions where ended_at is null and last_seen_at > now() - interval '5 minutes')));
$$;
