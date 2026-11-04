-- Wording for name + PIN sign-in.
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
    raise exception 'SIGNED_OUT: Signed out. Choose your name to continue.';
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
