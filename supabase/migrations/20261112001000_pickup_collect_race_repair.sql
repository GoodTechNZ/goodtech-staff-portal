-- Repair 16 pickups stuck at "Collection needs review: Invalid fulfillment order line item quantity
-- requested". In each, the portal shipped the order in Cin7, Cin7's Shopify integration then fulfilled
-- the Shopify order within seconds, and the portal's own Shopify fulfilmentCreate was rejected because
-- nothing was left to fulfil. All 16 were checked live on 12 Nov: Cin7 completed and Shopify FULFILLED
-- (one SUCCESS fulfilment, fulfilment order CLOSED, nothing remaining). This records them as collected
-- exactly as a successful collection does (pickup state, IMEI SHIPPED events, verification flags).
with fix(order_name, fulfillment_id, fulfilled_at) as (values
  ('#39209', 'gid://shopify/Fulfillment/6970864435289', '2026-10-24T00:20:11Z'::timestamptz),
  ('#39211', 'gid://shopify/Fulfillment/6975908937817', '2026-10-26T21:12:34Z'),
  ('#39225', 'gid://shopify/Fulfillment/6978536669273', '2026-10-27T22:30:04Z'),
  ('#39320', 'gid://shopify/Fulfillment/6985026273369', '2026-10-30T03:16:12Z'),
  ('#39330', 'gid://shopify/Fulfillment/6984965685337', '2026-10-30T02:28:23Z'),
  ('#39366', 'gid://shopify/Fulfillment/6987151966297', '2026-10-31T01:24:00Z'),
  ('#39384', 'gid://shopify/Fulfillment/6989082198105', '2026-11-01T22:15:49Z'),
  ('#39399', 'gid://shopify/Fulfillment/6993850171481', '2026-11-03T03:25:25Z'),
  ('#39426', 'gid://shopify/Fulfillment/7000252383321', '2026-11-04T22:43:11Z'),
  ('#39448', 'gid://shopify/Fulfillment/7006483316825', '2026-11-06T03:04:56Z'),
  ('#39453', 'gid://shopify/Fulfillment/7000078286937', '2026-11-04T21:20:06Z'),
  ('#39483', 'gid://shopify/Fulfillment/7006516904025', '2026-11-06T03:48:12Z'),
  ('#39496', 'gid://shopify/Fulfillment/7008806600793', '2026-11-07T01:43:34Z'),
  ('#39511', 'gid://shopify/Fulfillment/7008808829017', '2026-11-07T01:46:04Z'),
  ('#39585', 'gid://shopify/Fulfillment/7020557795417', '2026-11-11T23:33:03Z'),
  ('#39587', 'gid://shopify/Fulfillment/7020395429977', '2026-11-11T22:06:47Z')
), p as (
  select o.*, fix.fulfillment_id fid, fix.fulfilled_at from staff_pickup_orders o join fix using (order_name)
   where o.collect_status = 'review_required' and o.cin7_completed
     and o.last_error like '%Invalid fulfillment order line item quantity requested%'
), ev as (
  insert into imei_lifecycle_events(imei, event_type, event_at, sku, order_reference, cin7_sale_id, tracking_number, source, source_reference, staff, status, details)
  select v.scanned_imei, 'SHIPPED', p.fulfilled_at, v.scanned_sku, p.order_name, p.cin7_sale_id::text, null, 'staff_shipping',
         'pickup:' || p.cin7_sale_id || ':' || v.scanned_imei, p.collected_by, 'OUTBOUND',
         jsonb_build_object('delivery_method', 'pickup', 'cin7_order_number', v.cin7_order_number, 'collected', true, 'repaired', 'shopify fulfilled by Cin7 sync')
    from p join staff_shipping_verifications v on v.cin7_sale_id::text = p.cin7_sale_id::text
   where not exists (select 1 from imei_lifecycle_events e where e.source_reference = 'pickup:' || p.cin7_sale_id || ':' || v.scanned_imei)
  returning 1
), ver as (
  update staff_shipping_verifications v set cin7_shipped = true, cin7_imei_written = true,
         cin7_completed_at = coalesce(v.cin7_completed_at, p.fulfilled_at), notification_status = 'pickup_collected'
    from p where v.cin7_sale_id::text = p.cin7_sale_id::text
  returning 1
)
update staff_pickup_orders o set collect_status = 'collected', collected_at = p.fulfilled_at, fulfillment_id = p.fid,
       last_error = 'Repaired: Shopify was fulfilled by the Cin7 sync before the portal''s own request.'
  from p where o.cin7_sale_id = p.cin7_sale_id;
