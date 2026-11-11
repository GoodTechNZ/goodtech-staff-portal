-- Sales & Ops: 7 days and 30 days are complete days ending yesterday (today is excluded).
do $$
declare d text := pg_get_functiondef('public.portal_sales_ops(text)'::regprocedure);
begin
  if position('today - 7; d1 := today - 1' in d) = 0 then
    d := replace(d, $a$when '7d' then d0 := today - 6; d1 := today;$a$, $a$when '7d' then d0 := today - 7; d1 := today - 1;$a$);
    d := replace(d, $a$when '30d' then d0 := today - 29; d1 := today;$a$, $a$when '30d' then d0 := today - 30; d1 := today - 1;$a$);
    if position('today - 7; d1 := today - 1' in d) = 0 or position('today - 30; d1 := today - 1' in d) = 0 then
      raise exception 'portal_sales_ops period patch did not apply';
    end if;
    execute d;
  end if;
end $$;
