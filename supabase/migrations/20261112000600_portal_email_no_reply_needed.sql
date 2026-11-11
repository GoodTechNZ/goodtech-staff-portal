-- Sales & Ops Email: after we've replied in a thread, the customer's follow-up only keeps the thread
-- open if it needs an answer: a question (?) or a complaint / problem (still not working, refund,
-- broken, faulty, wrong, missing, not received, error, urgent, disappointed, cancel, damaged…).
-- Thanks, OKs, emoji reactions, confirmations ("please proceed", "will bring it in", "white
-- background") and requests staff just action ("if you could swap it") no longer count as open.
-- Threads we haven't replied to yet are always counted.
create or replace function public.portal_email_is_closing(p text)
returns boolean language sql immutable set search_path = pg_catalog as $fn$
  select x.s ~ 'reacted via gmail'
      or (strpos(x.s, '?') = 0 and x.s <> ''
          and x.s !~ '(not working|stopped working|doesn.?t work|does not work|isn.?t working|\mstill\M|\mrefund|\mbroken|\mfaulty|\mdefect|\mwrong\M|\mmissing|haven.?t (received|got|heard)|hasn.?t (arrived|come|been)|\mnot (yet )?(received|arrived)|\merror\M|\murgent|\mcomplain|\mdisappoint|\munhappy|\mcancel|when will|\masap\M|\mdamaged|\mcracked|\mscam|fair trading|consumer guarantee)')
  from (select lower(left(regexp_replace(coalesce(p, ''), '\s+', ' ', 'g'), 400)) as s) x
$fn$;
