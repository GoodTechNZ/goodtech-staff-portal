import {lineSignature} from './shipping-orders.ts';
type J = Record<string, any>;
const SHOPIFY_API_VERSION = "2026-07";
const PAGE_SIZE = 100;

function credentials() {
  const storeDomain = (Deno.env.get("SHOPIFY_STORE_DOMAIN") ?? "").trim().toLowerCase();
  const clientId = Deno.env.get("SHOPIFY_CLIENT_ID") ?? "";
  const clientSecret = Deno.env.get("SHOPIFY_CLIENT_SECRET") ?? "";
  if (!storeDomain || !clientId || !clientSecret) throw new Error("Missing Shopify credentials");
  return { storeDomain, clientId, clientSecret };
}
let cachedToken: string | null = null;
let cachedExpiry = 0;
async function accessToken() {
  if (cachedToken && Date.now() < cachedExpiry - 60000) return cachedToken;
  const { storeDomain, clientId, clientSecret } = credentials();
  const r = await fetch(`https://${storeDomain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret }),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`Shopify token ${r.status}: ${t.slice(0,400)}`);
  const p = JSON.parse(t);
  cachedToken = p.access_token;
  cachedExpiry = Date.now() + Number(p.expires_in ?? 0) * 1000;
  return cachedToken!;
}
export async function gql(query: string, variables: J) {
  const { storeDomain } = credentials();
  const token = await accessToken();
  const r = await fetch(`https://${storeDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`Shopify HTTP ${r.status}: ${t.slice(0,500)}`);
  const p = JSON.parse(t);
  if (p.errors) throw new Error(`Shopify GraphQL: ${JSON.stringify(p.errors).slice(0,1200)}`);
  return p;
}

export const SHIPPING_QUERY="query ShippingOrder($query:String!){orders(first:2,query:$query){nodes{id name email cancelledAt lineItems(first:100){nodes{sku quantity} pageInfo{hasNextPage}} fulfillments(first:50){id status createdAt trackingInfo{number} fulfillmentLineItems(first:100){nodes{quantity lineItem{sku}} pageInfo{hasNextPage}}} fulfillmentOrders(first:50){nodes{id status deliveryMethod{methodType} assignedLocation{name location{id}} lineItems(first:100){nodes{id remainingQuantity lineItem{sku}} pageInfo{hasNextPage}}} pageInfo{hasNextPage}} events(first:100,reverse:true){nodes{createdAt message ... on BasicEvent{action arguments}} pageInfo{hasNextPage}}} pageInfo{hasNextPage}}}";
const CREATE="mutation ShipOrder($fulfillment:FulfillmentInput!){fulfillmentCreate(fulfillment:$fulfillment){fulfillment{id status} userErrors{field message}}}";
const UPDATE="mutation NotifyShipment($id:ID!,$tracking:FulfillmentTrackingInput!){fulfillmentTrackingInfoUpdate(fulfillmentId:$id,trackingInfoInput:$tracking,notifyCustomer:true){fulfillment{id status} userErrors{field message}}}";

export async function loadShopifyOrder(name:string){
 if(!/^#\d+$/.test(name))throw new Error('This is not a Shopify order reference.');
 const p=await gql(SHIPPING_QUERY,{query:'name:'+name});const c=p.data?.orders;
 const matches=(c?.nodes||[]).filter((o:any)=>o.name===name);
 if(c?.pageInfo?.hasNextPage||matches.length!==1)throw new Error('Could not uniquely match this order in Shopify.');
 return matches[0];
}
export function notificationPlan(o:any,sh:any){
 if(deliveryMethod(o)!=='courier')throw new Error('Use the pickup actions for this order.');
 if(o.cancelledAt)throw new Error('The Shopify order is cancelled.');
 if(!o.email)throw new Error('The Shopify order has no customer email address.');
 if(o.lineItems.pageInfo.hasNextPage||o.fulfillmentOrders.pageInfo.hasNextPage||o.fulfillments.length>=50)throw new Error('This Shopify order is too large for automatic fulfilment.');
 if(lineSignature(o.lineItems.nodes)!==lineSignature(sh.line_items))throw new Error('Shopify products or quantities differ from the verified Cin7 order.');
 const fs=o.fulfillments.filter((f:any)=>f.status!=='CANCELLED');
 if(fs.length){
  if(fs.length!==1)throw new Error('Multiple Shopify fulfilments need review before notifying.');
  const f=fs[0];
  if(f.status!=='SUCCESS'||f.trackingInfo.length!==1||f.trackingInfo[0].number!==sh.tracking_number)throw new Error('Existing Shopify fulfilment has different tracking or is not successful.');
  if(f.fulfillmentLineItems.pageInfo.hasNextPage||lineSignature(f.fulfillmentLineItems.nodes.map((l:any)=>({sku:l.lineItem.sku,quantity:l.quantity})))!==lineSignature(sh.line_items))throw new Error('Existing Shopify fulfilment quantities do not match.');
  // Single complete fulfilment only: a recorded shipping email since its creation is sufficient to suppress another.
  const sent=o.events.nodes.some((e:any)=>e.action==='mail_sent'&&Date.parse(e.createdAt)>=Date.parse(f.createdAt)&&/shipping|shipment/i.test(e.message+' '+JSON.stringify(e.arguments)));
  return {kind:sent?'already_sent':'update',fulfillmentId:f.id};
 }
 const open=o.fulfillmentOrders.nodes.filter((f:any)=>['OPEN','IN_PROGRESS'].includes(f.status));
 if(!open.length||open.some((f:any)=>f.lineItems.pageInfo.hasNextPage))throw new Error('No complete set of open Shopify fulfilment items is available.');
 const locations=new Set(open.map((f:any)=>f.assignedLocation?.location?.id));
 if(locations.size!==1||locations.has(undefined))throw new Error('Multiple Shopify fulfilment locations need review.');
 const lines=open.flatMap((f:any)=>f.lineItems.nodes).filter((l:any)=>l.remainingQuantity>0);
 if(lineSignature(lines.map((l:any)=>({sku:l.lineItem.sku,quantity:l.remainingQuantity})))!==lineSignature(sh.line_items))throw new Error('Shopify remaining quantities do not match this parcel.');
 return {kind:'create',items:open.map((f:any)=>({fulfillmentOrderId:f.id,fulfillmentOrderLineItems:f.lineItems.nodes.filter((l:any)=>l.remainingQuantity>0).map((l:any)=>({id:l.id,quantity:l.remainingQuantity}))})).filter((f:any)=>f.fulfillmentOrderLineItems.length)};
}
export async function notifyShopify(db:any,sh:any){
 const prior=await db.from('staff_shipping_notifications').select('*').eq('tracking_number',sh.tracking_number).maybeSingle();
 if(prior.error)throw new Error('Unable to check the notification audit.');
 if(prior.data){
  if(prior.data.order_name!==sh.order_name)throw new Error('This tracking number is already linked to another notification.');
  return {status:prior.data.status,fulfillmentId:prior.data.fulfillment_id,note:prior.data.status==='requested'?'Shopify previously accepted the email request. No repeat was requested.':prior.data.status==='already_sent'?'Shopify already recorded a shipping email.':'An earlier email request needs review in Shopify; it will not be sent again automatically.'};
 }
 const o=await loadShopifyOrder(sh.order_name),plan=notificationPlan(o,sh);
 const claim=await db.from('staff_shipping_notifications').insert({tracking_number:sh.tracking_number,order_name:sh.order_name,shopify_order_id:o.id,status:'requesting'});
 if(claim.error)throw new Error('A notification request is already in progress. Reload the order to check.');
 try{
  let id=plan.fulfillmentId;
  if(plan.kind!=='already_sent'){
   const tracking={number:sh.tracking_number,company:sh.tracking_company||'NZ Post',url:'https://www.nzpost.co.nz/tools/tracking/item/'+encodeURIComponent(sh.tracking_number)};
   const p=plan.kind==='create'?await gql(CREATE,{fulfillment:{notifyCustomer:true,trackingInfo:tracking,lineItemsByFulfillmentOrder:plan.items}}):await gql(UPDATE,{id,tracking});
   const result=p.data?.[plan.kind==='create'?'fulfillmentCreate':'fulfillmentTrackingInfoUpdate'];
   if(!result?.fulfillment?.id||result.userErrors?.length)throw new Error(result?.userErrors?.map((e:any)=>e.message).join('; ')||'Shopify did not confirm the notification request.');
   id=result.fulfillment.id;
  }
  const status=plan.kind==='already_sent'?'already_sent':'requested';
  const saved=await db.from('staff_shipping_notifications').update({status,fulfillment_id:id,updated_at:new Date().toISOString()}).eq('tracking_number',sh.tracking_number);
  if(saved.error)throw new Error('Shopify responded, but saving the notification audit failed.');
  return {status,fulfillmentId:id,note:status==='already_sent'?'Shopify already recorded a shipping email.':'Shopify accepted the shipping email request.'};
 }catch(e){await db.from('staff_shipping_notifications').update({status:'review_required',error:String(e).slice(0,1000),updated_at:new Date().toISOString()}).eq('tracking_number',sh.tracking_number);throw e;}
}

export function deliveryMethod(o:any){
 if(o.fulfillmentOrders.pageInfo.hasNextPage)throw new Error('Too many fulfilments to determine the delivery method.');
 const active=o.fulfillmentOrders.nodes.filter((f:any)=>f.status!=='CANCELLED');
 const methods=new Set(active.map((f:any)=>f.deliveryMethod?.methodType));
 if(methods.size!==1)throw new Error('This order has mixed or unknown delivery methods. Review it in Shopify.');
 if(methods.has('PICK_UP'))return 'pickup';
 if(methods.has('SHIPPING'))return 'courier';
 throw new Error('This delivery method is not supported here. Review the order in Shopify.');
}
