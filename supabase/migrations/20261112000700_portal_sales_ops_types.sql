-- Sales & Ops: "Sales type" breakdown (net of returns), so in-store, replacement and repair revenue
-- is visible on its own:
--   Online (Shopify)  website, Reebelo and Trade Me orders
--   In-store sales    in-store devices and accessories (named staff and the In-Store Sales rep)
--   Repairs           Repairs sales group, or the Repairs rep
--   Replacement       Cin7 rep "Replacement" (replacement devices sent for returns)
--   Warranty          Cin7 rep "Warranty" (warranty jobs, usually $0)
do $$
declare d text := pg_get_functiondef('public.portal_sales_ops(text)'::regprocedure);
  anchor text := E'    ''returns'', (select jsonb_build_object(';
begin
  if position('''types''' in d) = 0 then
    if position(anchor in d) = 0 then raise exception 'portal_sales_ops patch anchor not found'; end if;
    d := replace(d, anchor, E'    ''types'', coalesce((select jsonb_agg(x order by x.ord) from (\n'
      || E'        select name, min(ord) ord, coalesce(sum(qty) filter (where grp = ''Devices''), 0) units, round(sum(rev), 2) revenue, round(sum(gp), 2) gp,\n'
      || E'               round(100 * sum(gp) / nullif(sum(rev) filter (where gp is not null), 0), 1) "gpPct"\n'
      || E'          from (select s.*,\n'
      || E'                  case when channel in (''Website'', ''Reebelo'', ''Trade Me'') then ''Online (Shopify)'' when staff = ''Replacement'' then ''Replacement''\n'
      || E'                       when staff = ''Warranty'' then ''Warranty'' when grp = ''Repairs'' or staff = ''Repairs'' then ''Repairs''\n'
      || E'                       when channel = ''In-store'' then ''In-store sales'' else channel end name,\n'
      || E'                  case when channel in (''Website'', ''Reebelo'', ''Trade Me'') then 1 when staff = ''Replacement'' then 4 when staff = ''Warranty'' then 5\n'
      || E'                       when grp = ''Repairs'' or staff = ''Repairs'' then 3 when channel = ''In-store'' then 2 else 6 end ord\n'
      || E'                from s) t group by name) x), ''[]''::jsonb),\n'
      || anchor);
    execute d;
  end if;
end $$;
