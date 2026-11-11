import {auditShipping,latestScan,scanBlock,validateSaved,errorReview} from './shipping-validation.ts';
import {pickupState,processPickup,finishStuckCollection} from './pickup-orders.ts';
import {shippingSettings,saveShippingSettings} from './shipping-settings.ts';
import {loadShopifyOrder,notificationPlan,notifyShopify,deliveryMethod} from "./shopify-shipping.ts";
import {getSalesOrder,printOrderLabel,lineSignature,cin7,shipRequest,writeSerialSaleNote,appendVerifiedSerials} from "./shipping-orders.ts";
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";

type J=Record<string,any>;



function normTracking(v:any){return String(v??"").trim().replace(/\s+/g,"");}
function data(r:any){if(r.error)throw new Error("Database operation failed.");return r.data;}
async function checkToken(req:Request,db:any){
  const token=req.headers.get("x-sales-desk-token")||"";
  if(token.length<40)throw Object.assign(new Error("Unauthorized"),{status:401});
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(token)))).map(x=>x.toString(16).padStart(2,"0")).join("");
  const cfg=data(await db.from("staff_sales_desk_config").select("value").eq("key","bridge_token_sha256").single());
  if(cfg.value!==hash)throw Object.assign(new Error("Unauthorized"),{status:401});
}
export async function getShipment(db:any,tracking:string,force=false){
  if(!force){
    const cached=data(await db.from("eship_shipments").select("shipment,fetched_at").eq("tracking_number",tracking).maybeSingle());
    if(cached&&Date.now()-Date.parse(cached.fetched_at)<30000)return cached.shipment;
  }
  const key=Deno.env.get("ESHIP_API_KEY"),sub=Deno.env.get("ESHIP_SUBSCRIPTION_KEY");
  if(!key||!sub)throw new Error("eShip connection is not configured.");
  async function get(path:string){
    const r=await fetch("https://api.starshipit.com/api/"+path,{headers:{"StarShipIT-Api-Key":key!,"Ocp-Apim-Subscription-Key":sub!,"Content-Type":"application/json"},signal:AbortSignal.timeout(25000)});
    if(!r.ok)throw new Error("eShip lookup failed (HTTP "+r.status+").");
    const d=await r.json();if(d.success===false||d.succeeded===false)throw new Error("eShip could not complete the lookup.");return d;
  }
  const found=await get("orders/search?phrase="+encodeURIComponent(tracking)+"&limit=250&page=1");
  if(Number(found.total_pages)>1)throw new Error("Tracking lookup returned too many matches. Review the label.");
  const matches=(found.orders||found.data?.orders||[]).filter((x:any)=>normTracking(x.tracking_number)===tracking&&!x.archived&&x.shipment_type!=="Return");
  if(matches.length!==1)throw new Error(matches.length?"Multiple eShip orders use this tracking number. Review the label.":"Tracking number not found on an active eShip label.");
  const m=matches[0],detail=await get("orders?order_id="+encodeURIComponent(m.order_id));
  const o=detail.order||detail.data?.order;
  if(!o||String(o.order_id)!==String(m.order_id)||String(o.order_number)!==String(m.order_number))throw new Error("eShip order details could not be verified.");
  const lines=(o.items||[]).map((i:any)=>({sku:String(i.sku||""),title:i.description||i.sku,quantity:Number(i.quantity)}));
  if(!lines.length||lines.some((i:any)=>!i.sku||!Number.isInteger(i.quantity)||i.quantity<1))throw new Error("eShip order has missing product codes or quantities.");
  const sh={source:"eship",eship_order_id:o.order_id,order_name:o.order_number,tracking_number:tracking,tracking_company:m.carrier_name||o.carrier_name,line_items:lines,fulfillment_status:o.status||o.order_status||m.order_status,shopify_order_id:null,fulfillment_id:null};
  data(await db.from("eship_shipments").upsert({tracking_number:tracking,eship_order_id:o.order_id,order_name:o.order_number,shipment:sh,fetched_at:new Date().toISOString()},{onConflict:"tracking_number"}));
  return sh;
}
export async function skuMeta(db:any,lines:any[]){
  const skus=[...new Set(lines.map(x=>String(x.sku||"")).filter(Boolean))];
  if(!skus.length)return [];
  const rows=data(await db.from("cin7_products").select("sku,name,raw").in("sku",skus));
  return skus.map(s=>{const p=rows.find((x:any)=>x.sku===s);return {sku:s,name:p?.name??lines.find(x=>x.sku===s)?.title??s,category:p?.raw?.Category??null,quantity:lines.filter(x=>x.sku===s).reduce((n:number,x:any)=>n+Number(x.quantity||0),0)}});
}
export function requiresSerial(category:any){return ["Unlocked Mobile Phones","Watches","Tablet Computers","Tablets","Laptop"].includes(String(category||""));}
async function imeiSku(db:any,imei:string){
  let r=data(await db.from("grading_sheet_current").select("product_code_raw,missing_from_sheet,changed_at").eq("serial_number",imei).eq("missing_from_sheet",false).order("changed_at",{ascending:false}).limit(1));
  if(r?.[0]?.product_code_raw&&r[0].product_code_raw!=="-")return String(r[0].product_code_raw);
  r=data(await db.from("grading_full_imports").select("product_code,imported_at").eq("serial_number",imei).order("imported_at",{ascending:false}).limit(1));
  if(r?.[0]?.product_code&&r[0].product_code!=="-")return String(r[0].product_code);
  return null;
}
async function findCin7Sale(db:any,orderName:string){
  const rows=data(await db.from("cin7_sales_raw").select("cin7_sale_id,order_number,detail,summary").or(`detail->>CustomerReference.eq.${orderName},summary->>CustomerReference.eq.${orderName}`).limit(3));
  if(rows.length!==1)throw new Error(rows.length?"More than one Cin7 sale matches this Shopify order.":"Cin7 sale has not synced yet.");
  return rows[0];
}
function shipLines(sale:any){return (sale?.Fulfilments??[]).flatMap((f:any)=>(f?.Ship?.Lines??[]).map((x:any)=>({...x,taskId:f.TaskID,shipStatus:f?.Ship?.Status,shippingNotes:f?.Ship?.ShippingNotes??""})));}
function nzDate(){return new Intl.DateTimeFormat("en-CA",{timeZone:"Pacific/Auckland",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());}

export default {fetch:withSupabase({auth:"none"},async(req,ctx)=>{
  let auditDb:any=null,auditContext:any=null,auditAction="";
  try{
    if(req.method!=="POST")return Response.json({error:"POST required"},{status:405});
    const db=ctx.supabaseAdmin;await checkToken(req,db);
    const b=await req.json();const action=String(b.action||"");
    if(!String(b.staff||'').trim())throw new Error('Select the staff member before continuing.');
    if(!String(b.owner||'').trim())throw new Error('Signed-in staff identity required.');
    if(action==='errors')return Response.json(await errorReview(db));
    if(['settings','save_settings'].includes(action)){
      if(!String(b.owner||'').trim())throw new Error('Signed-in staff identity required.');
      return Response.json({settings:action==='save_settings'?await saveShippingSettings(db,b.copyImeiToComments):await shippingSettings(db)});
    }
    if(!['lookup','scan','override','print','ship','pickup_ready','collect'].includes(action))throw new Error('Unknown action.');
    const so=String(b.salesOrderNumber||'').trim().toUpperCase();
    let shopifyOrder:any=null;
    const order=so?await getSalesOrder(db,so,async(sh:any)=>{shopifyOrder=await loadShopifyOrder(sh.order_name);return deliveryMethod(shopifyOrder);}):null;
    const sh=order?.shipment||await getShipment(db,normTracking(b.trackingNumber),action==='ship');
    if(order)sh.cin7_sale_id=order.local.cin7_sale_id;
    const shopifyLinked=order?sh.shopify_linked:/^#\d+$/.test(String(sh.order_name));
    // A pickup left at "Collection needs review" after Cin7 shipped it (the Cin7 sync fulfilled Shopify
    // first): finish recording it once Shopify shows it fully fulfilled. Cin7 then shows it as completed.
    if(order&&sh.shopify_linked){
      const stuck=await pickupState(db,order.local.cin7_sale_id);
      if(stuck?.collect_status==='review_required'&&stuck.cin7_completed)await finishStuckCollection(db,order,shopifyOrder||await loadShopifyOrder(sh.order_name),stuck);
    }
    if(sh.read_only&&action!=='lookup')throw new Error(sh.status_message+' Refresh to view the confirmed status. Further shipping actions are disabled.');
    const isPickup=sh.delivery_method==='pickup';
    if(isPickup){
      const state=await pickupState(db,order!.local.cin7_sale_id);
      sh.pickup_state=state?.collect_status==='collected'?'collected':state?.collect_status==='review_required'||state?.collect_status==='requesting'||state?.ready_status==='review_required'||state?.ready_status==='requesting'?'review_required':state?.ready_status==='ready'?'ready':'not_ready';
      sh.pickup_location=shopifyOrder.fulfillmentOrders.nodes.find((f:any)=>f.status!=='CANCELLED')?.assignedLocation?.name||'Store';
      sh.fulfillment_status=sh.pickup_state==='collected'?'Collected':sh.pickup_state==='ready'?'Ready for pickup':sh.pickup_state==='review_required'?'Needs review':'Awaiting preparation';
      sh.shopify_order_id=shopifyOrder.id;
      if(sh.pickup_state==='review_required')sh.label_issue='An earlier pickup action needs review in Cin7 and Shopify. Automatic repeat actions are blocked.';
    }
    if(isPickup&&['print','ship'].includes(action))throw new Error('This is an in-store pickup. Use Notify ready for pickup or Mark collected.');
    if(!isPickup&&['pickup_ready','collect'].includes(action))throw new Error('This is a courier order. Use Ship.');
    if(isPickup&&['scan','override'].includes(action)&&sh.pickup_state!=='not_ready')throw new Error('Pickup devices are locked after preparation. Review changes before collection.');
    const tracking=String(sh.tracking_number||'');
    const audit={cin7_sale_id:order?.local.cin7_sale_id||null,cin7_order_number:so||null,order_name:sh.order_name,tracking_number:tracking||null,staff:String(b.staff).trim().slice(0,120),owner_id:String(b.owner),expected_lines:sh.line_items||[],action};
    auditDb=db;auditContext=audit;auditAction=action;
    const scanKey=order?'SO:'+order.local.cin7_sale_id:tracking;
    const scope=(q:any)=>order?q.or('cin7_sale_id.eq.'+order.local.cin7_sale_id+',tracking_number.eq.'+(tracking||scanKey)):q.eq('tracking_number',tracking);
    const savedScans=async()=>data(await scope(db.from('staff_shipping_verifications').select('*')).eq('verified',true));
    const [meta,lookupScans]=await Promise.all([skuMeta(db,sh.line_items||[]),action==='lookup'?savedScans():Promise.resolve(null)]);
    if(!sh.read_only&&(!meta.length||meta.some((p:any)=>!p.category)))throw new Error("A product category is missing in Cin7. Review the product before shipping.");
    if(action!=="lookup"&&!String(b.staff||"").trim())throw new Error("Select the staff member.");
    if(action==="lookup"){
      return Response.json({shipment:sh,products:meta,scans:lookupScans,lastScan:await latestScan(db,audit.cin7_sale_id),emailNotificationEnabled:shopifyLinked});
    }
    if(action==='print'){
      if(!order)throw new Error('Scan the SO before printing.');
      const blocked=scanBlock(await latestScan(db,audit.cin7_sale_id));if(blocked)throw new Error(blocked);
      await validateSaved(await savedScans(),meta,imei=>imeiSku(db,imei));
      const requestEvent=await auditShipping(db,audit,'label_requested');
      const label=await printOrderLabel(db,order);
      await auditShipping(db,audit,'label_ready',{tracking_number:label.trackingNumber,related_event_id:requestEvent.id});
      sh.tracking_number=label.trackingNumber;sh.fulfillment_status='Printed';
      return Response.json({shipment:sh,products:meta,scans:await savedScans(),lastScan:await latestScan(db,audit.cin7_sale_id),labels:label.labels,emailNotificationEnabled:shopifyLinked});
    }
    if(action==="scan"||action==='override'){
      const imei=String(b.imei||"").trim();
      const fail=async(code:string,message:string,mapped:string|null=null)=>{
        const event=await auditShipping(db,audit,code,{scanned_imei:imei.slice(0,128),mapped_sku:mapped,error_message:message});
        return Response.json({error:message,code,scanEvent:event},{status:400});
      };
      if(!/^[a-zA-Z0-9-]{4,64}$/.test(imei))return await fail('invalid_scan','Scan a valid IMEI or serial number.');
      let mapped:string|null=null;
      try{mapped=await imeiSku(db,imei);}catch{return await fail('lookup_error','IMEI lookup is unavailable. Retry validation; a system error cannot be overridden.');}
      let originalError:any=null,reason='';
      if(action==='override'){
        const latest=await latestScan(db,audit.cin7_sale_id);
        if(!latest||latest.id!==b.scanEventId||latest.event_type!=='not_found'||latest.scanned_imei!==imei||latest.owner_id!==audit.owner_id)throw new Error('Only the latest recorded IMEI-not-found scan from this signed-in account can be overridden. Rescan the device.');
        originalError=latest;reason=String(b.overrideReason||'').trim().slice(0,1000);
        if(reason.length<10)throw new Error('Explain the manual device check and reason for the override (at least 10 characters).');
        const claimed=String(b.claimedSku||'');
        if(mapped&&mapped!==claimed)return await fail('wrong_device',`Wrong device: IMEI now maps to ${mapped}. Manual override is blocked.`,mapped);
        mapped=claimed;
      }else if(!mapped)return await fail('not_found','IMEI cannot be found in the grading records. Rescan or manually confirm the device and record an override.');
      const expected=meta.find((x:any)=>x.sku===mapped&&requiresSerial(x.category));
      if(!expected)return await fail('wrong_device',`Wrong device: IMEI maps to ${mapped}, which is not a device on this shipment.`,mapped);
      const prior=data(await db.from("staff_shipping_verifications").select("tracking_number,order_name,verified_at").eq("scanned_imei",imei).eq("verified",true).order("verified_at",{ascending:false}).limit(20));
      const lifecycle=data(await db.from("imei_lifecycle_events").select("event_type,event_at,order_reference,tracking_number,sku,location,status,source").eq("imei",imei).order("event_at",{ascending:false}).limit(50));
      const row={cin7_sale_id:order?.local.cin7_sale_id||null,cin7_order_number:so||null,tracking_number:tracking||scanKey,shopify_order_id:sh.shopify_order_id,order_name:sh.order_name,fulfillment_id:sh.fulfillment_id,expected_lines:sh.line_items||[],scanned_imei:imei,scanned_sku:mapped,matched_sku:mapped,verified:true,validation_method:action==='override'?'manual_not_found':'mapped',scan_error_id:originalError?.id||null,override_reason:reason||null,verified_by:String(b.staff||b.owner||"Staff").slice(0,120),verified_at:new Date().toISOString(),notification_method:shopifyLinked?"shopify":"none",notification_status:shopifyLinked?"pending_ship":"not_applicable",updated_at:new Date().toISOString()};
      const existing=(await savedScans()).find((x:any)=>x.scanned_imei===imei);
      if(!existing){
        const count=(await savedScans()).filter((x:any)=>x.scanned_sku===mapped);
        if(count.length>=expected.quantity)return await fail('quantity_error','All devices for this product are already verified.',mapped);
        const ins=await db.from("staff_shipping_verifications").insert(row);if(ins.error)throw ins.error;}
      const scanEvent=await auditShipping(db,audit,action==='override'?'manual_override':'verified',{scanned_imei:imei,mapped_sku:mapped,related_event_id:originalError?.id||null,override_reason:reason||null,claimed_sku:action==='override'?mapped:null});
      const scans=await savedScans();
      const previousShipments=prior.filter((x:any)=>x.tracking_number!==tracking&&x.tracking_number!==scanKey);
      return Response.json({ok:true,shipment:sh,products:meta,scans,lastScan:scanEvent,imeiHistory:lifecycle,previousShipments,emailNotificationEnabled:shopifyLinked});
    }
    if(["ship","pickup_ready","collect"].includes(action)){
      if(sh.label_issue)throw new Error(sh.label_issue);
      if(!isPickup&&!tracking)throw new Error('Print the shipping label before pressing Ship.');
      const scans=await savedScans();
      const required=meta.filter((x:any)=>requiresSerial(x.category));
      const blocked=scanBlock(await latestScan(db,audit.cin7_sale_id));if(blocked)throw new Error(blocked);
      await validateSaved(scans,meta,imei=>imeiSku(db,imei));
      await auditShipping(db,audit,'ship_requested');
      const settings=await shippingSettings(db);
      if(isPickup){
        if(settings.copyImeiToComments)await writeSerialSaleNote(order!.local.cin7_sale_id,sh.line_items,scans);
        const pickup=await processPickup(db,action,order!,shopifyOrder,scans,String(b.staff));
        sh.pickup_state=pickup.stage;sh.fulfillment_status=pickup.stage==='collected'?'Collected':'Ready for pickup';
        return Response.json({ok:true,shipment:sh,products:meta,scans,pickup,deliveryMethod:'pickup',orderName:sh.order_name,cin7OrderNumber:so,serialRequired:required.length>0});
      }
      if(shopifyLinked)notificationPlan(shopifyOrder||await loadShopifyOrder(sh.order_name),sh);
      const local=order?.local||await findCin7Sale(db,sh.order_name);const sale=order?.sale||await cin7("/Sale?ID="+encodeURIComponent(local.cin7_sale_id));
      if(String(sale.CustomerReference||sale.Order?.SaleOrderNumber||"")!==String(sh.order_name))throw new Error("Cin7 sale reference does not match this shipment.");
      const saleNoteWritten=settings.copyImeiToComments?await writeSerialSaleNote(local.cin7_sale_id,sh.line_items,scans):false;
      const existing=shipLines(sale);const matched=existing.find((x:any)=>normTracking(x.TrackingNumber)===tracking&&x.IsShipped&&x.shipStatus==="AUTHORISED");
      let trackingWritten=false, imeiWritten=false, alreadyShipped=false;
      if(matched){
        trackingWritten=true;alreadyShipped=true;imeiWritten=scans.length>0&&scans.every((s:any)=>String(matched.shippingNotes||"").includes(s.scanned_imei));
      }else if(String(sale.CombinedShippingStatus||"").toUpperCase()==="SHIPPED"){
        throw new Error("Cin7 is already shipped with a different tracking number. Review before proceeding.");
      }else{
        const f=sale.Fulfilments?.[0];const task=f?.TaskID||local.cin7_sale_id;
        let packed=await cin7("/Sale/Fulfilment/Pack?TaskID="+encodeURIComponent(task));
        if(String(packed.Status||'').toUpperCase()!=='AUTHORISED'){
          const picked=await cin7('/Sale/Fulfilment/Pick?TaskID='+encodeURIComponent(task));
          if(picked.Status!=='AUTHORISED'||lineSignature(picked.Lines||[])!==lineSignature(sh.line_items))throw new Error('Cin7 picking must be authorised for all items before shipping.');
          await cin7('/Sale/Fulfilment/Pack','POST',{TaskID:task,Status:'AUTHORISED',Lines:picked.Lines.map((p:any)=>({...p,Box:'1'}))});
          packed=await cin7('/Sale/Fulfilment/Pack?TaskID='+encodeURIComponent(task));
        }
        if(packed.Status!=='AUTHORISED'||lineSignature(packed.Lines||[])!==lineSignature(sh.line_items))throw new Error('Cin7 packed items do not match this order.');
        const draft=await cin7("/Sale/Fulfilment/Ship?TaskID="+encodeURIComponent(task));
        const existingNotes=draft.ShippingNotes||packed.ShippingNotes||f?.Ship?.ShippingNotes||'';
        const notes=scans.length?appendVerifiedSerials(existingNotes,scans,'shipping notes'):[existingNotes,'Non-device parcel verified by '+String(b.staff)].filter(Boolean).join('\n');
        const request=shipRequest(task,packed,draft,sh,notes,nzDate());
        await cin7("/Sale/Fulfilment/Ship",request.method,request.body);
        const verify=await cin7("/Sale?ID="+encodeURIComponent(local.cin7_sale_id));
        const line=shipLines(verify).find((x:any)=>normTracking(x.TrackingNumber)===tracking&&x.IsShipped&&x.shipStatus==="AUTHORISED");
        if(!line)throw new Error("Cin7 did not confirm the tracking number.");
        trackingWritten=true;imeiWritten=scans.length>0&&scans.every((s:any)=>String(line.shippingNotes||"").includes(s.scanned_imei));
        if(scans.length&&!imeiWritten)throw new Error('Cin7 shipment is confirmed, but IMEI shipping notes were not confirmed. Review this order in Cin7 before retrying.');
      }
      await auditShipping(db,audit,'shipped');
      const ids=scans.map((x:any)=>x.id);
      if(ids.length)data(await db.from("staff_shipping_verifications").update({tracking_number:tracking,cin7_sale_id:local.cin7_sale_id,cin7_order_number:local.order_number,cin7_tracking_written:trackingWritten,cin7_imei_written:imeiWritten,cin7_shipped:true,cin7_completed_at:new Date().toISOString(),notification_method:shopifyLinked?"shopify":"none",notification_status:shopifyLinked?"pending_ship":"not_applicable",last_error:null,updated_at:new Date().toISOString()}).in("id",ids));
      for(const s of scans){
        const exists=data(await db.from("imei_lifecycle_events").select("id").eq("imei",s.scanned_imei).eq("event_type","SHIPPED").eq("tracking_number",tracking).limit(1));
        if(!exists.length){
          const ins=await db.from("imei_lifecycle_events").insert({
            imei:s.scanned_imei,event_type:"SHIPPED",event_at:new Date().toISOString(),sku:s.scanned_sku,
            order_reference:sh.order_name,cin7_sale_id:local.cin7_sale_id,tracking_number:tracking,
            source:"staff_shipping",source_reference:String(s.id),staff:s.verified_by,
            status:"OUTBOUND",details:{cin7_order_number:local.order_number,email_notification:shopifyLinked?"pending_request":"not_applicable"}
          });
          if(ins.error)throw ins.error;
        }
      }
      data(await db.from("staff_shipping_completions").upsert({tracking_number:tracking,order_name:sh.order_name,cin7_sale_id:local.cin7_sale_id,staff:String(b.staff),device_count:scans.length,result:{trackingWritten,imeiWritten,saleNoteWritten,alreadyShipped},completed_at:new Date().toISOString()},{onConflict:"tracking_number"}));
      let notification={status:'not_applicable',note:'Cin7 shipment confirmed. This order is not linked to Shopify; no Shopify email was requested.'};
      try{if(shopifyLinked)notification=await notifyShopify(db,sh);}catch(e){notification={status:'review_required',note:'Cin7 shipment is confirmed, but the Shopify email needs review: '+(e instanceof Error?e.message:String(e))};}
      if(ids.length)await db.from('staff_shipping_verifications').update({notification_status:notification.status,notification_at:new Date().toISOString()}).in('id',ids);
      return Response.json({notification,serialRequired:required.length>0,ok:true,orderName:sh.order_name,cin7OrderNumber:local.order_number,trackingNumber:tracking,trackingWritten,imeiWritten,saleNoteWritten,copyImeiToComments:settings.copyImeiToComments,alreadyShipped,emailNotificationRequested:notification.status==='requested',emailNotificationEnabled:shopifyLinked,note:alreadyShipped&&scans.length>0&&!imeiWritten?"IMEI saved in Cin7 sale notes. The already-authorised shipment's shipping notes were left unchanged.":null});
    }
    throw new Error("Unknown action.");
  }catch(e:any){if(auditDb&&auditContext&&['print','ship','pickup_ready','collect','override','scan'].includes(auditAction)){try{await auditShipping(auditDb,auditContext,'operation_error',{error_message:String(e?.message||e).slice(0,2000)});}catch{}}return Response.json({error:e?.message||"Shipping operation failed."},{status:e?.status||400});}
})};
