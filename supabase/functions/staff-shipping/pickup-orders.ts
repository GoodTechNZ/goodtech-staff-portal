import {cin7,lineSignature,shipRequest} from './shipping-orders.ts';
import {gql,deliveryMethod,loadShopifyOrder} from './shopify-shipping.ts';
type J=Record<string,any>;
export const READY_QUERY='mutation ReadyForPickup($input:FulfillmentOrderLineItemsPreparedForPickupInput!){fulfillmentOrderLineItemsPreparedForPickup(input:$input){userErrors{field message}}}';
export const COLLECT_QUERY='mutation CollectOrder($fulfillment:FulfillmentInput!){fulfillmentCreate(fulfillment:$fulfillment){fulfillment{id status} userErrors{field message}}}';
const checked=(r:any)=>{if(r.error)throw new Error('Unable to save or read the pickup audit. Refresh the order before retrying.');return r.data;};
export const serialSnapshot=(scans:J[])=>scans.map(s=>({imei:s.scanned_imei,sku:s.scanned_sku})).sort((a,b)=>a.imei.localeCompare(b.imei));
export async function pickupState(db:any,id:string){return checked(await db.from('staff_pickup_orders').select('*').eq('cin7_sale_id',id).maybeSingle());}
export function pickupPlan(o:J,sh:J){
 if(deliveryMethod(o)!=='pickup')throw new Error('This is a courier order. Use Ship.');
 if(o.cancelledAt)throw new Error('The Shopify order is cancelled.');
 if(!o.email)throw new Error('The Shopify order has no customer email address.');
 if(o.lineItems.pageInfo.hasNextPage||lineSignature(o.lineItems.nodes)!==lineSignature(sh.line_items))throw new Error('Shopify items differ from the verified Cin7 order.');
 const fs=o.fulfillments.filter((f:J)=>f.status!=='CANCELLED');
 if(fs.length)throw new Error('This pickup already has a Shopify fulfilment. Review collection in Shopify before proceeding.');
 const orders=o.fulfillmentOrders.nodes.filter((f:J)=>f.status!=='CANCELLED');
 if(orders.length!==1)throw new Error('Multiple pickup fulfilments need review in Shopify.');
 const f=orders[0];
 if(!['OPEN','IN_PROGRESS'].includes(f.status)||f.lineItems.pageInfo.hasNextPage||!f.assignedLocation?.location?.id)throw new Error('This pickup fulfilment is not ready for processing in Shopify.');
 const items=f.lineItems.nodes.filter((l:J)=>l.remainingQuantity>0);
 if(lineSignature(items.map((l:J)=>({sku:l.lineItem.sku,quantity:l.remainingQuantity})))!==lineSignature(sh.line_items))throw new Error('Shopify remaining pickup quantities differ from Cin7.');
 return {id:f.id,locationId:f.assignedLocation.location.id,location:f.assignedLocation.name,items:[{fulfillmentOrderId:f.id,fulfillmentOrderLineItems:items.map((l:J)=>({id:l.id,quantity:l.remainingQuantity}))}]};
}
async function packedOrder(order:J){
 const {sale,shipment:sh,local}=order;
 if((sale.Fulfilments||[]).length>1)throw new Error('Multiple Cin7 fulfilments need review.');
 if(sale.Fulfilments?.some((f:J)=>f.Ship?.Lines?.some((l:J)=>l.IsShipped))||sale.CombinedShippingStatus==='SHIPPED')throw new Error('Cin7 already records this order as shipped. Review it before preparing a pickup.');
 const task=sale.Fulfilments?.[0]?.TaskID||local.cin7_sale_id;
 let packed=await cin7('/Sale/Fulfilment/Pack?TaskID='+encodeURIComponent(task));
 if(packed.Status!=='AUTHORISED'){
  const picked=await cin7('/Sale/Fulfilment/Pick?TaskID='+encodeURIComponent(task));
  if(picked.Status!=='AUTHORISED'||lineSignature(picked.Lines||[])!==lineSignature(sh.line_items))throw new Error('Authorise picking for all items in Cin7 before preparing the pickup.');
  await cin7('/Sale/Fulfilment/Pack','POST',{TaskID:task,Status:'AUTHORISED',Lines:picked.Lines.map((l:J)=>({...l,Box:'1'}))});
  packed=await cin7('/Sale/Fulfilment/Pack?TaskID='+encodeURIComponent(task));
 }
 if(packed.Status!=='AUTHORISED'||lineSignature(packed.Lines||[])!==lineSignature(sh.line_items))throw new Error('Cin7 packed items do not match this order.');
 return {task,packed};
}
export function assertReadySnapshot(state:J,order:J,scans:J[],plan:J){
 if(state.ready_status!=='ready')throw new Error('The ready-for-pickup notification must be confirmed before collection.');
 // JSONB may reorder object keys. Compare the actual identifiers, not JSON formatting.
 const signature=(serials:J[])=>JSON.stringify(serials.map(s=>[s.imei,s.sku]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));
 if(state.order_signature!==lineSignature(order.shipment.line_items))throw new Error('Items or quantities changed after preparation. Review the pickup in Cin7 and Shopify before collection.');
 if(!Array.isArray(state.serials)||signature(state.serials)!==signature(serialSnapshot(scans)))throw new Error('Verified devices changed after preparation. Review the pickup before collection.');
 if(state.fulfillment_order_id!==plan.id||state.location_id!==plan.locationId)throw new Error('Pickup fulfilment or location changed after preparation. Review the pickup in Shopify before collection.');
}
// The Shopify order is already fully fulfilled (e.g. by the Cin7 sync) with exactly this order's items:
// returns the fulfilment ID, else null. Anything partial or different stays for review.
export function fulfilledFor(o:J,sh:J):string|null{
 const open=(o.fulfillmentOrders?.nodes||[]).filter((f:J)=>f.status!=='CANCELLED');
 if(!open.length||open.some((f:J)=>f.lineItems?.pageInfo?.hasNextPage||(f.lineItems?.nodes||[]).some((l:J)=>Number(l.remainingQuantity)>0)))return null;
 const done=(o.fulfillments||[]).filter((f:J)=>f.status==='SUCCESS');
 if(!done.length||done.some((f:J)=>f.fulfillmentLineItems?.pageInfo?.hasNextPage))return null;
 const items=done.flatMap((f:J)=>(f.fulfillmentLineItems?.nodes||[]).map((l:J)=>({sku:l.lineItem?.sku,quantity:l.quantity})));
 try{if(lineSignature(items)!==lineSignature(sh.line_items))return null;}catch{return null;}
 return done[done.length-1].id;
}
async function collectedInShopify(sh:J){return fulfilledFor(await loadShopifyOrder(sh.order_name),sh);}
async function recordCollected(db:any,order:J,scans:J[],staff:string,fulfillmentId:string){
 const sh=order.shipment,id=order.local.cin7_sale_id;
 checked(await db.from('staff_pickup_orders').update({fulfillment_id:fulfillmentId}).eq('cin7_sale_id',id));
 for(const scan of scans){
  checked(await db.from('imei_lifecycle_events').insert({imei:scan.scanned_imei,event_type:'SHIPPED',event_at:new Date().toISOString(),sku:scan.scanned_sku,order_reference:sh.order_name,cin7_sale_id:id,tracking_number:null,source:'staff_shipping',source_reference:'pickup:'+id+':'+scan.scanned_imei,staff,status:'OUTBOUND',details:{delivery_method:'pickup',cin7_order_number:order.local.order_number,collected:true}}));
 }
 if(scans.length)checked(await db.from('staff_shipping_verifications').update({cin7_shipped:true,cin7_imei_written:true,cin7_completed_at:new Date().toISOString(),notification_status:'pickup_collected'}).in('id',scans.map(s=>s.id)));
 checked(await db.from('staff_pickup_orders').update({collect_status:'collected',collected_at:new Date().toISOString(),last_error:null}).eq('cin7_sale_id',id));
}
// A collection left for review after Cin7 shipped it, typically because the Cin7 sync fulfilled the
// Shopify order before the portal's own request: once Shopify is fully fulfilled with exactly this
// order's items, record the collection (by whoever pressed Mark collected). Runs when the SO is looked up.
export async function finishStuckCollection(db:any,order:J,o:J,state:J){
 if(state?.collect_status!=='review_required'||!state.cin7_completed)return false;
 const fid=fulfilledFor(o,order.shipment);
 if(!fid)return false;
 const scans=checked(await db.from('staff_shipping_verifications').select('*').eq('cin7_sale_id',order.local.cin7_sale_id).eq('verified',true));
 await recordCollected(db,order,scans,state.collected_by||'Staff',fid);
 checked(await db.from('staff_pickup_orders').update({last_error:'Completed on lookup: Shopify was already fulfilled (Cin7 sync).'}).eq('cin7_sale_id',order.local.cin7_sale_id));
 return true;
}
export async function processPickup(db:any,action:string,order:J,o:J,scans:J[],staff:string){
 const sh=order.shipment,id=order.local.cin7_sale_id;
 let state=await pickupState(db,id);
 if(action==='pickup_ready'&&state){
  if(state.ready_status!=='ready')throw new Error('An earlier pickup email request needs review in Shopify. It will not be resent automatically.');
  return {stage:state.collect_status==='collected'?'collected':'ready',note:'Pickup was already prepared; no duplicate email was requested.'};
 }
 if(action==='collect'&&state?.collect_status==='collected')return {stage:'collected',note:'Collection was already recorded. No email was sent.'};
 if(action==='collect'&&(!state||state.collect_status!=='not_started'))throw new Error('An earlier collection needs review, or the order has not been prepared. Refresh and check Shopify and Cin7.');
 const plan=pickupPlan(o,sh);
 if(action==='collect')assertReadySnapshot(state,order,scans,plan);
 // Packing may be completed here, but no Cin7 shipment is authorised until collection.
 const {task,packed}=await packedOrder(order);
 if(action==='pickup_ready'){
  // A previously prepared Shopify pickup outside this portal needs manual review, not another email.
  if(o.events.nodes.some((e:J)=>/ready.{0,12}(for.{0,3})?pick.?up|pick.?up.{0,12}ready/i.test(e.message+' '+JSON.stringify(e.arguments))))throw new Error('Shopify already records pickup preparation. Review this order there to avoid a duplicate notification.');
  checked(await db.from('staff_pickup_orders').insert({cin7_sale_id:id,order_name:sh.order_name,shopify_order_id:o.id,fulfillment_order_id:plan.id,location_id:plan.locationId,order_signature:lineSignature(sh.line_items),serials:serialSnapshot(scans),ready_status:'requesting',prepared_by:staff}));
  try{
   const p=await gql(READY_QUERY,{input:{lineItemsByFulfillmentOrder:[{fulfillmentOrderId:plan.id}]}});
   const result=p.data?.fulfillmentOrderLineItemsPreparedForPickup;
   if(!result||!Array.isArray(result.userErrors)||result.userErrors.length)throw new Error(result?.userErrors?.map((e:J)=>e.message).join('; ')||'Shopify did not confirm pickup preparation.');
   checked(await db.from('staff_pickup_orders').update({ready_status:'ready',ready_at:new Date().toISOString()}).eq('cin7_sale_id',id));
   return {stage:'ready',note:'Shopify accepted the Ready for pickup email request. Cin7 is packed and awaiting collection.'};
  }catch(e){await db.from('staff_pickup_orders').update({ready_status:'review_required',last_error:String(e).slice(0,1000)}).eq('cin7_sale_id',id);throw e;}
 }
 const claim=checked(await db.from('staff_pickup_orders').update({collect_status:'requesting',collected_by:staff}).eq('cin7_sale_id',id).eq('collect_status','not_started').select('cin7_sale_id'));
 if(claim.length!==1)throw new Error('Collection is already being processed. Refresh before retrying.');
 try{
  const draft=await cin7('/Sale/Fulfilment/Ship?TaskID='+encodeURIComponent(task));
  const marker='Collected in store ['+id+']';
  const notes=[draft.ShippingNotes||'',marker+' by '+staff,scans.length?'Verified IMEI / serial: '+scans.map(s=>s.scanned_imei).join(', '):'Non-device items verified'].filter(Boolean).join('\n');
  const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Pacific/Auckland',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const request=shipRequest(task,packed,draft,{...sh,delivery_method:'pickup'},notes,date);
  await cin7('/Sale/Fulfilment/Ship',request.method,request.body);
  const verify=await cin7('/Sale/Fulfilment/Ship?TaskID='+encodeURIComponent(task));
  if(verify.Status!=='AUTHORISED'||!verify.Lines?.length||verify.Lines.some((l:J)=>!l.IsShipped||l.TrackingNumber||l.Carrier!=='1a Elgin Street')||verify.ShippingAddress?.Line1!=='1a Elgin Street'||!String(verify.ShippingNotes).includes(marker))throw new Error('Cin7 did not confirm collection. Review the order before retrying.');
  checked(await db.from('staff_pickup_orders').update({cin7_completed:true}).eq('cin7_sale_id',id));
  // Cin7's Shopify integration usually fulfils the Shopify order itself within seconds of the Cin7
  // shipment above. Adopt that fulfilment when it already covers every item; only create one when
  // Shopify still has items open (and check again if Shopify rejects ours because Cin7 got there first).
  let fulfillmentId=await collectedInShopify(sh);
  if(!fulfillmentId){
   // notifyCustomer:false prevents Shopify's shipping confirmation email for an in-store handover.
   const p=await gql(COLLECT_QUERY,{fulfillment:{notifyCustomer:false,lineItemsByFulfillmentOrder:plan.items}});
   const f=p.data?.fulfillmentCreate;
   if(f?.fulfillment?.id&&f.fulfillment.status==='SUCCESS'&&!f.userErrors?.length)fulfillmentId=f.fulfillment.id;
   else{
    fulfillmentId=await collectedInShopify(sh);
    if(!fulfillmentId)throw new Error(f?.userErrors?.map((e:J)=>e.message).join('; ')||'Shopify did not confirm collection fulfilment.');
   }
  }
  await recordCollected(db,order,scans,staff,fulfillmentId);
  return {stage:'collected',note:'Collection recorded in Cin7 and Shopify. No shipping email was sent.'};
 }catch(e){await db.from('staff_pickup_orders').update({collect_status:'review_required',last_error:String(e).slice(0,1000)}).eq('cin7_sale_id',id);throw new Error('Collection needs review: '+(e instanceof Error?e.message:String(e)));}
}
