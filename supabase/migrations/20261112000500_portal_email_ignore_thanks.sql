-- Sales & Ops Email: open threads whose last customer message is only a thanks / OK / emoji reaction
-- to a reply we already sent no longer count as open (they need no reply). A message stays open if it
-- has a question mark or a new ask (please, can you, issue, return, swap, need, still, not working…).

create or replace function public.portal_email_is_closing(p text)
returns boolean language sql immutable set search_path = pg_catalog as $$
  with t as (select lower(left(regexp_replace(coalesce(p, ''), '\s+', ' ', 'g'), 300)) s)
  select s ~ 'reacted via gmail'
      or ( array_to_string((regexp_split_to_array(s, ' '))[1:30], ' ') ~ '(\mthank|\mthanks\M|\mthx\M|\mty\M|appreciat|\mlegend\M|\mperfect\M|\mgreat\M|\mawesome\M|\mno worries\M|\mwill do\M|\mok\M|\mokay\M|\msounds good\M|\mgot it\M|\mnoted\M|\mmuch appreciated\M)'
           and position('?' in s) = 0
           and regexp_replace(s, '(no problem|no worries|no issue)', '', 'g') !~ '(\mplease\M|\mpls\M|could you|can you|would you|\missue|\mproblem|\merror|not working|doesn.?t|does not|isn.?t|\mstill\M|\mrefund|\mreturn|\mswap|\mexchange|when will|\mneeds?\M|\minterested\M|\mbroken|\mfault|\mwrong|\mmissing|\mhaven.?t|\mhasn.?t|\myet\M)')
  from t $$;

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
  ), cust as (
    select * from waiting
     where addr in (select addr from replied)
        or split_part(addr, '@', 2) ~ '^(gmail|googlemail|hotmail|outlook|live|msn|icloud|me|mac|yahoo|xtra|slingshot|orcon|vodafone|spark|windowslive|protonmail|proton)\.'
  ), closing as (
    -- The customer's last message only thanks or acknowledges a reply we already sent.
    select c.thread_id from cust c
     where exists (select 1 from service_email_messages o where o.thread_id = c.thread_id and o.direction = 'out' and not o.is_automated)
       and public.portal_email_is_closing((select m.body_preview from service_email_messages m
             where m.thread_id = c.thread_id and m.direction = 'in' order by m.sent_at desc limit 1))
  ), aw as (
    select * from cust where thread_id not in (select thread_id from closing)
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
        'otherSenders', (select count(*) from waiting where hours_waiting <= 336) - (select count(*) from cust where hours_waiting <= 336),
        'acknowledged', (select count(*) from cust where hours_waiting <= 336 and thread_id in (select thread_id from closing))) from aw),
    'longestWaiting', coalesce((select jsonb_agg(x order by x.hours desc) from (
        select coalesce(nullif(btrim(subject), ''), '(no subject)') subject, round(hours_waiting) hours
          from aw where hours_waiting <= 336 order by hours_waiting desc limit 5) x), '[]'::jsonb),
    'syncedAt', (select max("at") from service_email_sync_log));
$$;
revoke all on function public.portal_sales_ops_email(date, date) from public, anon, authenticated;
grant execute on function public.portal_sales_ops_email(date, date) to service_role;
