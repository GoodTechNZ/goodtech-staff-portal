type J=Record<string,any>;
export function appendVerifiedSerials(existing:any,scans:J[],field='sale notes'){
 const text=String(existing??'');
 const tokens=new Set(text.split(/[^a-zA-Z0-9-]+/));
 const missing=[...new Set(scans.map(s=>String(s.scanned_imei)))].filter(s=>!tokens.has(s));
 const note=missing.length?[text,'Verified IMEI / serial: '+missing.join(', ')].filter(Boolean).join('\n'):text;
 if(note.length>1024)throw new Error(`Cin7 ${field} exceed 1024 characters. Shorten the existing notes before completing this order.`);
 return note;
}
// Cin7 GET may leave Line1 empty while returning the existing address in
// DisplayAddressLine1. PUT requires Line1 even when only notes are changed.
export function writableAddress(address:J,field='shipping address'){
 if(String(address.Line1||'').trim())return {...address};
 let line1=String(address.DisplayAddressLine1||'').trim();
 const line2=String(address.Line2||'').trim();
 // The display field combines Line1 and Line2. Do not duplicate Line2.
 if(line2){
  if(!line1.endsWith(line2))throw new Error(`Cin7 ${field} needs review. Enter Address Line 1 in Cin7, save the order, then refresh.`);
  line1=line1.slice(0,-line2.length).replace(/[,\s]+$/,'');
 }
 if(!line1)throw new Error(`Cin7 ${field} is missing Address Line 1. Enter the existing address in Cin7, save the order, then refresh.`);
 return {...address,Line1:line1};
}
// Sale/Order supports GET and POST only; POST rejects authorised orders.
// Use the editable sale header Note for searchable identifiers without undoing fulfilment.
export async function writeSerialSaleNote(id:string,expectedLines:J[],scans:J[]){
 if(!scans.length)return false;
 const path='/Sale?ID='+encodeURIComponent(id),sale=await cin7(path);
 if(sale.ID!==id||!['AUTHORISED','FULFILLED'].includes(sale.Order?.Status)||/VOID|CANCEL/i.test(sale.Status)||lineSignature(sale.Order.Lines)!==lineSignature(expectedLines))throw new Error('Cin7 order changed before saving the verified IMEI. Refresh and review it.');
 const note=appendVerifiedSerials(sale.Note,scans);
 if(note!==String(sale.Note??'')){
  const body:J={ID:id,Note:note};
  // Preserve the documented header fields; never send nested order or fulfilment data.
  for(const key of ['CustomerID','Customer','Contact','Phone','Email','DefaultAccount','SkipQuote','BillingAddress','ShippingAddress','ShippingNotes','TaxRule','TaxInclusive','Terms','PriceTier','ShipBy','Location','SaleOrderDate','CustomerReference','CurrencyRate','SalesRepresentative','Carrier','ExternalID','AdditionalAttributes'])if(sale[key]!==undefined)body[key]=sale[key];
  for(const key of ['BillingAddress','ShippingAddress'])if(body[key])body[key]=writableAddress(body[key],key==='BillingAddress'?'billing address':'shipping address');
  await cin7('/Sale','PUT',body);
 }
 const verified=await cin7(path);
 if(verified.ID!==id||appendVerifiedSerials(verified.Note,scans)!==String(verified.Note??''))throw new Error('Cin7 did not confirm the IMEI in sale notes. Refresh the order before retrying.');
 return true;
}
export async function cin7(path:string,method="GET",body?:any){
 const r=await fetch("https://inventory.dearsystems.com/ExternalApi/v2"+path,{method,headers:{accept:"application/json","Content-Type":"application/json","api-auth-accountid":Deno.env.get("CIN7_ACCOUNT_ID")||"","api-auth-applicationkey":Deno.env.get("CIN7_APPLICATION_KEY")||""},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(45000)});
 let p:any;try{p=await r.json();}catch{throw new Error(`Cin7 ${method} ${path.split('?')[0]} returned an unreadable response (HTTP ${r.status}). Refresh the order before retrying.`);}
 if(!r.ok||p?.Errors?.length||p?.ErrorCode||Array.isArray(p)&&p.some((x:any)=>x?.ErrorCode)){
  const errors=Array.isArray(p)?p:p.Errors||[p];
  const detail=errors.map((x:any)=>typeof x==='string'?x:x.Exception||x.Message||x.ErrorMessage||x.ErrorCode).filter(Boolean).join('; ').slice(0,700);
  throw new Error(`Cin7 ${method} ${path.split('?')[0]} failed (HTTP ${r.status})${detail?': '+detail:'.'}`);
 }return p;
}
export class EshipRateLimitError extends Error {}
export async function eship(path:string,method="GET",body?:any){
 for(let attempt=0;attempt<4;attempt++){
  const r=await fetch("https://api.starshipit.com/api/"+path,{method,headers:{"Content-Type":"application/json","StarShipIT-Api-Key":Deno.env.get("ESHIP_API_KEY")||"","Ocp-Apim-Subscription-Key":Deno.env.get("ESHIP_SUBSCRIPTION_KEY")||""},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(45000)});
  // A gateway 429 rejects the request before processing. Never automatically retry
  // a timeout, 5xx, malformed success, or other ambiguous label-creation response.
  if(r.status===429){
   const header=r.headers?.get('Retry-After');
   const seconds=header?(Number.isFinite(Number(header))?Number(header):Math.max(0,(Date.parse(header)-Date.now())/1000)):0;
   const delay=Math.max(1000*2**attempt,Number.isFinite(seconds)?seconds*1000:0)+250;
   await r.text();
   if(attempt===3||delay>10000)throw new EshipRateLimitError('eShip is busy and has not accepted this request. Wait a few seconds, then try again.');
   await new Promise(resolve=>setTimeout(resolve,delay));continue;
  }
  const d=await r.json();if(!r.ok||d.success===false||d.succeeded===false)throw new Error("eShip could not complete the request: "+JSON.stringify(d.errors||d.message||r.status).slice(0,700));return d;
 }
 throw new EshipRateLimitError('eShip is busy. Please try again shortly.');
}

function rows(r:any){if(r.error)throw new Error("Unable to load shipping records.");return r.data;}
export function lineSignature(lines:any[]){const m=new Map<string,number>();for(const l of lines){const sku=String(l.sku||l.SKU||'');const n=Number(l.quantity??l.Quantity);if(!sku||!Number.isInteger(n)||n<1)throw new Error('The order has invalid product codes or quantities.');m.set(sku,(m.get(sku)||0)+n);}return JSON.stringify([...m].sort(([a],[b])=>a.localeCompare(b)));}
const clean=(v:any)=>String(v||'').toLowerCase().replace(/[^a-z0-9]/g,'');
export function addressMatches(a:J,d:J){return !!clean(a.Line1)&&clean(a.Line1)===clean(d.street)&&!!clean(a.Postcode)&&clean(a.Postcode)===clean(d.post_code);}
export async function getSalesOrder(db:any,so:string,resolveDelivery?:(sh:J)=>Promise<string>){
 if(!/^SO\d+$/i.test(so))throw new Error('Scan a Cin7 sales order number, for example SO66192.');
 const list=rows(await db.from('cin7_sales_raw').select('cin7_sale_id,order_number,shopify_reference:detail->>CustomerReference').eq('order_number',so.toUpperCase()).limit(2));
 if(list.length!==1)throw new Error(list.length?'More than one Cin7 sale matches this SO.':'Sales order not found in the Cin7 feed yet.');
 const local=list[0],cachedRef=String(local.shopify_reference||'');
 // Only prefetch delivery classification. The live Cin7 identity and reference remain authoritative.
 // Capture rejection immediately so a failed Cin7 request cannot leave an unhandled promise.
 const prefetched=resolveDelivery&&/^#\d+$/.test(cachedRef)
  ?resolveDelivery({order_name:cachedRef}).then(value=>({value,error:null}),error=>({value:'',error}))
  :null;
 const sale=await cin7('/Sale?ID='+encodeURIComponent(local.cin7_sale_id));
 if(sale.Order?.SaleOrderNumber!==so.toUpperCase()||sale.ID!==local.cin7_sale_id)throw new Error('Cin7 order identity did not match.');
 const lines=(sale.Order?.Lines||[]).map((l:any)=>({sku:l.SKU,title:l.Name,quantity:Number(l.Quantity)}));
 const a=sale.ShippingAddress||{},ref=String(sale.CustomerReference||so);
 const sh:J={source:'eship',cin7_sale_id:local.cin7_sale_id,cin7_order_number:so.toUpperCase(),order_name:ref,customer_name:a.Contact||sale.Contact||sale.Customer,customer_company:a.Company||sale.Customer,shipping_address:[a.Line1,a.Line2,a.City,a.State,a.Postcode,a.Country].filter(Boolean),line_items:lines,tracking_number:'',tracking_company:'',fulfillment_status:'Awaiting label',shopify_order_id:null,fulfillment_id:null,eship_order_id:null,label_issue:null};
 sh.cin7_status=String(sale.Status||'Unknown');
 sh.cin7_order_status=String(sale.Order?.Status||'Unknown');
 sh.cin7_shipping_status=String(sale.CombinedShippingStatus||'Unknown');
 sh.status_checked_at=new Date().toISOString();
 sh.confirmed_shipped=sh.cin7_shipping_status.toUpperCase()==='SHIPPED';
 sh.shipment_records=(sale.Fulfilments||[]).flatMap((f:J)=>(f.Ship?.Lines||[]).map((l:J)=>({tracking_number:String(l.TrackingNumber||''),carrier:String(l.Carrier||''),shipment_date:l.ShipmentDate||null,is_shipped:l.IsShipped===true,ship_status:String(f.Ship?.Status||'Unknown')})));
 sh.read_only=/VOID|CANCEL/i.test(sh.cin7_status)||sale.Order?.Status!=='AUTHORISED'||sh.confirmed_shipped||sh.cin7_status.toUpperCase()==='COMPLETED';
 sh.shopify_linked=/^#\d+$/.test(ref);
 if(sh.read_only){
  sh.source='cin7';sh.fulfillment_status=sh.cin7_shipping_status;
  sh.status_message=sh.confirmed_shipped?'Already shipped — confirmed in Cin7.':`Cin7 status: ${sh.cin7_status}; order: ${sh.cin7_order_status}; shipping: ${sh.cin7_shipping_status}.`;
  const recorded=sh.shipment_records.filter((l:J)=>l.is_shipped&&l.ship_status==='AUTHORISED');
  if(recorded.length===1){sh.tracking_number=recorded[0].tracking_number;sh.tracking_company=recorded[0].carrier;}
  return {shipment:sh,sale,local,eshipOrder:null};
 }
 lineSignature(lines);
 if(!lines.length)throw new Error('This sales order has no products.');
 sh.delivery_method='courier';
 if(resolveDelivery&&sh.shopify_linked){
  const early=prefetched?await prefetched:null;
  if(early&&cachedRef===ref){if(early.error)throw early.error;sh.delivery_method=early.value;}
  else sh.delivery_method=await resolveDelivery(sh);
  if(sh.delivery_method==='pickup'){
   if((sale.Fulfilments||[]).length>1)throw new Error('This SO has multiple fulfilments. Complete it in Cin7.');
   sh.source='shopify';sh.fulfillment_status='Awaiting preparation';
   return {shipment:sh,sale,local,eshipOrder:null};
  }
 }
 let o:J|null=null;
 try{
  const found=await eship('orders/search?phrase='+encodeURIComponent(ref)+'&fields=Order_Number&status=All&limit=250&page=1');
  const matches=(found.orders||found.data?.orders||[]).filter((x:any)=>String(x.order_number)===ref&&!x.archived&&x.shipment_type!=='Return');
  if(Number(found.total_pages)>1||matches.length!==1)throw new Error(matches.length?'Multiple eShip orders match this reference. Review them in eShip.':'No matching eShip order yet. Import the order into eShip, then reload this SO.');
  const m=matches[0],detail=await eship('orders?order_id='+encodeURIComponent(m.order_id));o=detail.order||detail.data?.order;
  if(!o||String(o.order_id)!==String(m.order_id)||String(o.order_number)!==ref)throw new Error('eShip order identity did not match.');
  sh.eship_order_id=o.order_id;sh.fulfillment_status=o.status||o.order_status||m.order_status;sh.tracking_company=o.carrier_name||m.carrier_name||o.carrier;
  const tracking=[...new Set([...(o.packages||[]).map((p:any)=>p.tracking_number),...(o.tracking_numbers||[]),m.tracking_number].filter(Boolean).map(String))];
  if(tracking.length>1||(o.packages||[]).length>1)throw new Error('This order has multiple parcels. Complete it in eShip and Cin7.');
  sh.tracking_number=tracking[0]||'';
  if(lineSignature(lines)!==lineSignature(o.items||[]))throw new Error('eShip products or quantities differ from Cin7. Correct the order before printing or shipping.');
  if(!addressMatches(a,o.destination||{}))throw new Error('The eShip street address or postcode differs from Cin7. Correct the address before printing or shipping.');
  if((sale.Fulfilments||[]).length>1)throw new Error('This SO has multiple fulfilments. Complete it in Cin7.');
 }catch(e){sh.label_issue=e instanceof Error?e.message:'eShip lookup failed.';}
 return {shipment:sh,sale,local,eshipOrder:o};
}
export async function printOrderLabel(db:any,context:any){
 const {shipment:sh,eshipOrder:o}=context;
 if(sh.label_issue)throw new Error(sh.label_issue);
 if(!o||!sh.eship_order_id)throw new Error('A matching eShip order is required.');
 const id=String(sh.eship_order_id),cached=rows(await db.from('staff_shipping_labels').select('*').eq('eship_order_id',id).maybeSingle());
 if(cached?.state==='complete'&&cached.tracking_number===sh.tracking_number&&cached.labels?.length)return {labels:cached.labels,trackingNumber:cached.tracking_number};
 const printed=!!sh.tracking_number;
 if(cached&&!printed)throw new Error('A previous label request needs review in eShip. Reload the SO after confirming whether a label was created; do not create another shipment.');
 if(!printed&&/^(printed|shipped|delivered|cancelled|archived)$/i.test(sh.fulfillment_status||''))throw new Error('eShip status needs review before creating a label.');
 if(!cached){const ins=await db.from('staff_shipping_labels').insert({eship_order_id:id,cin7_sale_id:sh.cin7_sale_id,state:'requesting'});if(ins.error)throw new Error('A label request is already in progress. Reload this SO.');}
 try{
  // Existing eShip courier and parcel settings are authoritative. Reprint never creates a new shipment.
  const r=await eship('orders/shipment','POST',{order_id:o.order_id,carrier:o.carrier,carrier_service_code:o.carrier_service_code,packages:(o.packages||[]).map((p:any)=>({weight:p.weight,height:p.height,width:p.width,length:p.length,packaging_type:p.packaging_type})),reprint:printed});
  if(String(r.order_id)!==id||String(r.order_number)!==String(sh.order_name))throw new Error('Returned label identity did not match. Review in eShip.');
  const labels=(r.labels||[]).filter((x:any)=>typeof x==='string'&&x.startsWith('JVBER'));
  const ts=r.tracking_numbers||[];
  if(labels.length!==1||ts.length!==1||!ts[0]||(printed&&ts[0]!==sh.tracking_number))throw new Error('Label or tracking could not be verified. Review in eShip before retrying.');
  rows(await db.from('staff_shipping_labels').update({state:'complete',labels,tracking_number:ts[0],updated_at:new Date().toISOString()}).eq('eship_order_id',id));
  return {labels,trackingNumber:ts[0]};
 }catch(e){
  if(e instanceof EshipRateLimitError&&!cached){
   // Only release our own new claim after a definite rejection. Unknown outcomes stay locked.
   const released=await db.from('staff_shipping_labels').delete().eq('eship_order_id',id).eq('state','requesting');
   if(released.error)throw new Error('eShip rejected the request, but its retry lock could not be cleared. Contact support before retrying.');
  }else if(!(e instanceof EshipRateLimitError))await db.from('staff_shipping_labels').update({state:'uncertain',updated_at:new Date().toISOString()}).eq('eship_order_id',id);
  throw e;
 }
}

// Cin7 v2 returns Boxes, but requires Box for POST/PUT. PUT replaces draft lines.
export function shipRequest(task:string,packed:J,draft:J,sh:J,notes:string,date:string){
 if(packed.Status!=='AUTHORISED')throw new Error('Cin7 packing must be authorised before shipping.');
 if(!['DRAFT','NOT AVAILABLE'].includes(draft.Status))throw new Error('Cin7 shipment is already authorised or partially shipped. Refresh the order and review it.');
 const boxes=[...new Set((packed.Lines||[]).map((x:any)=>String(x.Box||'').trim()))];
 if(boxes.length!==1||!boxes[0]||boxes[0].includes(','))throw new Error('This shipping screen requires one packed box. Review the Cin7 packing boxes.');
 const lines=draft.Lines||[];
 if(lines.length>1)throw new Error('Cin7 has multiple shipping rows. Review them before shipping.');
 const line=lines[0];
 if(line&&(line.IsShipped||String(line.Boxes||line.Box||'').trim()!==boxes[0]||line.TrackingNumber&&String(line.TrackingNumber).trim()!==sh.tracking_number))throw new Error('The existing Cin7 shipment does not match this label or packed box. Review it before shipping.');
 if(!sh.tracking_number&&sh.delivery_method!=='pickup')throw new Error('Print the shipping label before shipping.');
 if(notes.length>1024)throw new Error('Cin7 shipping notes exceed 1024 characters. Shorten the existing notes before shipping.');
 const pickup=sh.delivery_method==='pickup';
 const shippingAddress=pickup?{Line1:'1a Elgin Street',Line2:'Grey Lynn',City:'Auckland',State:'Auckland',Postcode:'1021',Country:'New Zealand',Company:'GoodTech',Contact:draft.ShippingAddress?.Contact||sh.customer_name||'',ShipToOther:true}:draft.ShippingAddress?writableAddress(draft.ShippingAddress):null;
 return {method:lines.length?'PUT':'POST',body:{TaskID:task,Status:'AUTHORISED',RequireBy:draft.RequireBy??null,...(shippingAddress?{ShippingAddress:shippingAddress}:{}),ShippingNotes:notes,Lines:[{ShipmentDate:date,Carrier:pickup?'1a Elgin Street':line?.Carrier||sh.tracking_company||'NZ Post',Box:boxes[0],TrackingNumber:pickup?'':sh.tracking_number,IsShipped:true}]}};
}
