type J=Record<string,any>;
export const scanEvents=['verified','not_found','wrong_device','invalid_scan','lookup_error','quantity_error','manual_override'];
export async function auditShipping(db:any,context:J,event_type:string,extra:J={}){
 const r=await db.from('staff_shipping_events').insert({...context,...extra,event_type}).select('*').single();
 if(r.error)throw new Error('Unable to save the shipping audit. No further action is allowed until logging is available.');
 return r.data;
}
export async function latestScan(db:any,saleId:string){
 const r=await db.from('staff_shipping_events').select('*').eq('cin7_sale_id',saleId).in('event_type',scanEvents).order('sequence',{ascending:false}).limit(1);
 if(r.error)throw new Error('Unable to check the shipping scan audit.');return r.data?.[0]||null;
}
export function scanBlock(event:J|null){
 if(!event||['verified','manual_override'].includes(event.event_type))return '';
 return event.event_type==='not_found'?'IMEI not found. Rescan or record a manual override before printing or shipping.':'The last device scan failed. Scan the correct device successfully before printing or shipping. Wrong devices cannot be overridden.';
}
export async function validateSaved(scans:J[],meta:J[],lookup:(imei:string)=>Promise<string|null>){
 const required=meta.filter(p=>['Unlocked Mobile Phones','Watches','Tablet Computers','Tablets','Laptop'].includes(p.category));
 if(new Set(scans.map(s=>s.scanned_imei)).size!==scans.length)throw new Error('Duplicate device scans need review.');
 for(const s of scans){
  const p=required.find(p=>p.sku===s.scanned_sku);
  if(!p||!s.verified)throw new Error('A saved device verification no longer matches this shipment.');
  const mapped=await lookup(s.scanned_imei);
  if(s.validation_method==='manual_not_found'){
   if(!s.scan_error_id||!s.override_reason)throw new Error('Manual IMEI override audit is missing.');
   if(mapped&&mapped!==s.scanned_sku)throw new Error('Wrong device: an overridden IMEI now maps to a different product. Rescan the correct device.');
  }else if(mapped!==s.scanned_sku)throw new Error('A saved device verification no longer matches this shipment.');
 }
 for(const p of required){const n=scans.filter(s=>s.scanned_sku===p.sku).length;if(n>p.quantity)throw new Error('Too many verified devices. Review scans.');if(n<p.quantity)throw new Error(`Scan ${p.quantity-n} more IMEI(s) for ${p.sku} before printing or shipping.`);}
}
export async function errorReview(db:any){
 const types=['wrong_device','not_found','invalid_scan','lookup_error','quantity_error','manual_override'];
 const rows=await db.from('staff_shipping_events').select('*').in('event_type',types).order('sequence',{ascending:false}).limit(200);
 if(rows.error)throw new Error('Unable to load scan errors.');
 const counts:Record<string,number>={};
 for(const type of types){const r=await db.from('staff_shipping_events').select('id',{head:true,count:'exact'}).eq('event_type',type);if(r.error)throw new Error('Unable to count scan errors.');counts[type]=r.count||0;}
 return {events:rows.data,counts};
}
