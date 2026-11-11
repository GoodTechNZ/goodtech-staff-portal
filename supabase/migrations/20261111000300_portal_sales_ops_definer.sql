-- Sales & Ops read the reporting_cache copy, which the API role (service_role) can't see.
-- Run the read as the function owner instead; only service_role can call it.
alter function public.portal_sales_ops(text) security definer;
revoke all on function public.portal_sales_ops(text) from public, anon, authenticated;
grant execute on function public.portal_sales_ops(text) to service_role;
