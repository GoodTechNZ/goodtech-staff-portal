const key='shipping_copy_imei_to_comments';
export async function shippingSettings(db:any){
 const r=await db.from('staff_sales_desk_config').select('value').eq('key',key).maybeSingle();
 if(r.error)throw new Error('Unable to load shipping settings. Retry before completing this order.');
 if(r.data&& !['true','false'].includes(r.data.value))throw new Error('Shipping settings need review.');
 return {copyImeiToComments:r.data?.value!=='false'};
}
export async function saveShippingSettings(db:any,value:unknown){
 if(typeof value!=='boolean')throw new Error('Choose whether to copy IMEI to comments.');
 const r=await db.from('staff_sales_desk_config').upsert({key,value:String(value)},{onConflict:'key'});
 if(r.error)throw new Error('Unable to save shipping settings. Please retry.');
 const verified=await shippingSettings(db);
 if(verified.copyImeiToComments!==value)throw new Error('The setting changed while saving. Reload shipping settings.');
 return verified;
}
