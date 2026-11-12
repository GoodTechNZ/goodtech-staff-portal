-- Sales & Ops: Website, Reebelo and Trade Me shown separately.
--   Channels: always lists Website, In-store, Reebelo and Trade Me (0 when a channel has no sales in the
--             period, e.g. Today before the first marketplace order), plus any other channel with sales.
--   Sales type: the online channels are split (Website / Reebelo / Trade Me) instead of one
--             "Online (Shopify)" line; then In-store sales, Repairs, Replacement, Warranty.
do $$
declare d text := pg_get_functiondef('public.portal_sales_ops(text)'::regprocedure);
  c_old text := E'          from s group by channel) x), ''[]''::jsonb),';
  c_new text := E'          from (select channel, grp, qty, rev, gp from s\n'
             || E'                union all select c, ''Devices'', 0, 0, null from unnest(array[''Website'', ''In-store'', ''Reebelo'', ''Trade Me'']) c) s2\n'
             || E'         group by channel) x), ''[]''::jsonb),';
  n_old text := E'case when channel in (''Website'', ''Reebelo'', ''Trade Me'') then ''Online (Shopify)'' when staff';
  n_new text := E'case when channel in (''Website'', ''Reebelo'', ''Trade Me'') then channel when staff';
  o_old text := E'case when channel in (''Website'', ''Reebelo'', ''Trade Me'') then 1 when staff = ''Replacement'' then 4 when staff = ''Warranty'' then 5\n'
             || E'                       when grp = ''Repairs'' or staff = ''Repairs'' then 3 when channel = ''In-store'' then 2 else 6 end ord';
  o_new text := E'case channel when ''Website'' then 1 when ''Reebelo'' then 2 when ''Trade Me'' then 3 else\n'
             || E'                       case when staff = ''Replacement'' then 6 when staff = ''Warranty'' then 7\n'
             || E'                       when grp = ''Repairs'' or staff = ''Repairs'' then 5 when channel = ''In-store'' then 4 else 8 end end ord';
begin
  if position(c_old in d) = 0 then raise exception 'channels anchor not found'; end if;
  if position(n_old in d) = 0 then raise exception 'types name anchor not found'; end if;
  if position(o_old in d) = 0 then raise exception 'types order anchor not found'; end if;
  d := replace(replace(replace(d, c_old, c_new), n_old, n_new), o_old, o_new);
  execute d;
end $$;
