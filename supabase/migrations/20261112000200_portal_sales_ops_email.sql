-- Sales & Ops: Email section, from the service mailbox sync (service_email_messages and its views).
--   Replied (in the period): customer replies sent, threads answered and median first-response time, by staff.
--   Open now: threads whose last message is from the sender and still unanswered (service_email_awaiting_reply),
--             by age, counting customer emails only: senders we've replied to before, or personal addresses
--             (Gmail, Hotmail, iCloud, Xtra…). Supplier stock lists, marketing and notifications are left out.
--             Threads waiting more than 14 days are counted separately; most need no reply.
create or replace function public.portal_sales_ops_email(d0 date, d1 date)
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  with rep as (
    select * from service_email_replies where sent_date_nz between d0 and d1
  ), replied as (
    select distinct lower(m[1]) addr
      from service_email_messages o, regexp_matches(coalesce(o.to_addrs, ''), '([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]+)', 'g') m
     where o.direction = 'out' and not o.is_automated
  ), waiting as (
    select a.*, lower(substring(a.from_addr from '([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]+)')) addr from service_email_awaiting_reply a
  ), aw as (
    select * from waiting
     where addr in (select addr from replied)
        or split_part(addr, '@', 2) ~ '^(gmail|googlemail|hotmail|outlook|live|msn|icloud|me|mac|yahoo|xtra|slingshot|orcon|vodafone|spark|windowslive|protonmail|proton)\.'
  )
  select jsonb_build_object(
    'replies', (select count(*) from rep),
    'threads', (select count(distinct thread_id) from rep),
    'medianMinutes', (select round((percentile_cont(0.5) within group (order by response_minutes))::numeric) from rep),
    'staff', coalesce((select jsonb_agg(x order by x.replies desc) from (
        select staff name, count(*) replies, count(distinct thread_id) threads,
               round((percentile_cont(0.5) within group (order by response_minutes))::numeric) "medianMinutes"
          from rep group by staff) x), '[]'::jsonb),
    'open', (select jsonb_build_object(
        'total', count(*) filter (where hours_waiting <= 336),
        'under24h', count(*) filter (where hours_waiting <= 24),
        'days1to3', count(*) filter (where hours_waiting > 24 and hours_waiting <= 72),
        'days3to14', count(*) filter (where hours_waiting > 72 and hours_waiting <= 336),
        'older', count(*) filter (where hours_waiting > 336),
        'otherSenders', (select count(*) from waiting where hours_waiting <= 336) - count(*) filter (where hours_waiting <= 336)) from aw),
    'longestWaiting', coalesce((select jsonb_agg(x order by x.hours desc) from (
        select coalesce(nullif(btrim(subject), ''), '(no subject)') subject, round(hours_waiting) hours
          from aw where hours_waiting <= 336 order by hours_waiting desc limit 5) x), '[]'::jsonb),
    'syncedAt', (select max("at") from service_email_sync_log));
$$;
revoke all on function public.portal_sales_ops_email(date, date) from public, anon, authenticated;
grant execute on function public.portal_sales_ops_email(date, date) to service_role;

-- Add it to the Sales & Ops payload.
do $$
declare d text := pg_get_functiondef('public.portal_sales_ops(text)'::regprocedure);
  old text := E'  ) into out;\n  return out;';
begin
  if position('portal_sales_ops_email' in d) = 0 then
    if position(old in d) = 0 then raise exception 'portal_sales_ops patch anchor not found'; end if;
    d := replace(d, old, E'  ) into out;\n  return out || jsonb_build_object(''email'', public.portal_sales_ops_email(d0, d1));');
    execute d;
  end if;
end $$;
