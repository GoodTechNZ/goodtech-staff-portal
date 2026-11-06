-- Terminal enrolment by one-time codes only.
--
-- * The standing enrolment code is retired.
-- * Only staff with can_enrol (Fraser) can create a code, from Admin with their PIN.
-- * A code works once, expires after 15 minutes, and only from the same network (public IP) it
--   was created on, so a code made in the shop only works on the shop's Wi-Fi.
-- Terminals already enrolled keep working.

alter table public.staff add column if not exists can_enrol boolean not null default false;
update public.staff set can_enrol = true where display_name = 'Fraser';

alter table public.portal_terminals add column if not exists enrolled_by uuid references public.staff(id);
alter table public.portal_terminals add column if not exists enrolled_ip text;

create table if not exists public.portal_enrol_codes (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique,
  created_by uuid not null references public.staff(id),
  created_ip text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_terminal uuid references public.portal_terminals(id),
  failed_attempts integer not null default 0
);
alter table public.portal_enrol_codes enable row level security;
revoke all on public.portal_enrol_codes from anon, authenticated;
grant select, insert, update on public.portal_enrol_codes to service_role;

delete from public.portal_config where key = 'terminal_enrol_code_hash';

create or replace function public.portal_enrol_code_create(p_staff uuid, p_terminal uuid, p_ip text)
returns jsonb language plpgsql volatile set search_path = '' as $$
declare s public.staff; v_code text := ''; v_alphabet text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; i integer; v_exp timestamptz;
begin
  select * into s from public.staff where id = p_staff;
  if not found or not s.active or not s.can_enrol then raise exception 'Only Fraser can create enrolment codes.'; end if;
  if nullif(btrim(p_ip), '') is null then raise exception 'Could not tell which network this device is on. Try again.'; end if;
  for i in 1..8 loop
    v_code := v_code || substr(v_alphabet, 1 + (get_byte(extensions.gen_random_bytes(1), 0) % length(v_alphabet)), 1);
  end loop;
  v_code := substr(v_code, 1, 4) || '-' || substr(v_code, 5, 4);
  v_exp := now() + interval '15 minutes';
  -- Any earlier unused code from this person stops working.
  update public.portal_enrol_codes set expires_at = least(expires_at, now()) where created_by = p_staff and used_at is null and expires_at > now();
  insert into public.portal_enrol_codes(code_hash, created_by, created_ip, expires_at) values (public.portal_token_hash(v_code), p_staff, p_ip, v_exp);
  perform public.portal_log(p_staff, null, p_terminal, 'admin', 'enrol_code', null, 'ok', jsonb_build_object('ip', p_ip, 'expires', v_exp));
  return jsonb_build_object('code', v_code, 'expiresAt', v_exp, 'ip', p_ip);
end $$;

drop function if exists public.portal_terminal_enrol(text, text);
create or replace function public.portal_terminal_enrol(p_code text, p_name text, p_ip text)
returns jsonb language plpgsql volatile set search_path = '' as $$
declare c public.portal_enrol_codes; v_token text; v_id uuid;
begin
  select * into c from public.portal_enrol_codes
   where code_hash = public.portal_token_hash(upper(btrim(coalesce(p_code, '')))) for update;
  if not found or c.used_at is not null or c.expires_at <= now() then
    perform pg_sleep(1);
    raise exception 'This enrolment code is not valid or has expired. Ask Fraser for a new one.';
  end if;
  if c.created_ip is distinct from btrim(coalesce(p_ip, '')) then
    update public.portal_enrol_codes set failed_attempts = failed_attempts + 1,
      expires_at = case when failed_attempts + 1 >= 3 then now() else expires_at end where id = c.id;
    perform public.portal_log(c.created_by, null, null, 'terminal', 'enrol_wrong_network', left(p_name, 60), 'denied', jsonb_build_object('ip', p_ip, 'expected', c.created_ip));
    return jsonb_build_object('ok', false, 'error', 'Enrol this device on the same Wi-Fi network the code was created on.');
  end if;
  if nullif(btrim(p_name), '') is null or length(p_name) > 60 then raise exception 'Enter a terminal name.'; end if;
  v_token := public.portal_new_token();
  insert into public.portal_terminals(name, token_hash, enrolled_by, enrolled_ip) values (btrim(p_name), public.portal_token_hash(v_token), c.created_by, p_ip) returning id into v_id;
  update public.portal_enrol_codes set used_at = now(), used_terminal = v_id where id = c.id;
  perform public.portal_log(c.created_by, null, v_id, 'terminal', 'enrol', btrim(p_name), 'ok', jsonb_build_object('ip', p_ip));
  return jsonb_build_object('ok', true, 'terminalId', v_id, 'terminalToken', v_token, 'name', btrim(p_name));
end $$;

revoke all on function public.portal_enrol_code_create(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.portal_terminal_enrol(text, text, text) from public, anon, authenticated;
grant execute on function public.portal_enrol_code_create(uuid, uuid, text) to service_role;
grant execute on function public.portal_terminal_enrol(text, text, text) to service_role;
