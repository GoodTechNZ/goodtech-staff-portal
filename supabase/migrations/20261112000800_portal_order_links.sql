-- Links for Cin7 SO numbers and Shopify order numbers shown in the portal.
--   SO67212 -> Cin7 sale ID (cin7_sales_raw), opened at https://inventory.dearsystems.com/Sale#<id>~<id>~tabOrder
--   #39430  -> Shopify order ID (shopify_orders), opened at https://admin.shopify.com/store/goodtech/orders/<id>
-- Returns { "SO67212": "<url>", "#39430": "<url>" } for the refs that are found.
create or replace function public.portal_order_links(p_refs text[])
returns jsonb language sql stable security definer set search_path = public, pg_temp as $$
  with refs as (
    select distinct upper(btrim(r)) ref from unnest(coalesce(p_refs, '{}')) r
     where upper(btrim(r)) ~ '^(SO\d{3,8}|#\d{3,8})$' limit 300
  )
  select coalesce(jsonb_object_agg(ref, url), '{}'::jsonb) from (
    select r.ref, 'https://inventory.dearsystems.com/Sale#' || s.cin7_sale_id || '~' || s.cin7_sale_id || '~tabOrder' url
      from refs r join lateral (select cin7_sale_id from cin7_sales_raw where order_number = r.ref order by order_date desc limit 1) s on true
     where r.ref like 'SO%'
    union all
    select r.ref, 'https://admin.shopify.com/store/goodtech/orders/' || regexp_replace(o.order_id, '^.*/', '') url
      from refs r join lateral (select order_id from shopify_orders where order_name = r.ref limit 1) o on true
     where r.ref like '#%'
  ) x;
$$;
revoke all on function public.portal_order_links(text[]) from public, anon, authenticated;
grant execute on function public.portal_order_links(text[]) to service_role;
