import { call, ApiError, J } from '../api.ts';
import { h, mount, message, scanInput, askPin, busy, confirmDialog } from '../ui.ts';
import type { ScreenCtx } from '../main.ts';

// Shipping: scan the SO (or the label tracking number), scan each device IMEI, print the label,
// then Ship. In-store pickups use Notify ready / Mark collected. All Cin7, eShip and Shopify
// work is done by the existing staff-shipping function; this screen only drives it.

type Key = { salesOrderNumber?: string; trackingNumber?: string };

export function orderKey(scan: string): Key {
  const v = scan.trim().toUpperCase();
  return /^SO\d+$/.test(v) ? { salesOrderNumber: v } : { trackingNumber: scan.trim().replace(/\s+/g, '') };
}

function openLabels(labels: string[]) {
  for (const b64 of labels) {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const w = window.open(url, '_blank');
    if (!w) { const a = h('a', { href: url, download: 'label.pdf' }); a.click(); }
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  }
}

export function shippingScreen(ctx: ScreenCtx): HTMLElement {
  const status = h('div', { class: 'status-slot' });
  const work = h('div', { class: 'stack' });
  let key: Key = {};
  const scan = scanInput({ placeholder: 'Scan SO number or label tracking number', label: 'Sales order or tracking number', onScan: v => load(orderKey(v)) });

  async function load(k: Key) {
    status.replaceChildren();
    scan.disabled = true;
    try {
      key = k;
      render(await call('shipping.lookup', k));
    } catch (err) {
      mount(work);
      status.replaceChildren(message('error', err instanceof ApiError ? err.message : 'Lookup failed.'));
    } finally { scan.disabled = false; scan.value = ''; }
  }

  function render(d: J, note?: HTMLElement) {
    const sh = d.shipment || {};
    const products: J[] = d.products || [];
    const scans: J[] = d.scans || [];
    const pickup = sh.delivery_method === 'pickup';
    const readOnly = !!sh.read_only;
    const slot = h('div', { class: 'status-slot' }, note || null);
    const serialProducts = products.filter(p => ['Unlocked Mobile Phones', 'Watches', 'Tablet Computers', 'Tablets', 'Laptop'].includes(p.category));
    const needed = serialProducts.reduce((n, p) => n + Number(p.quantity || 0), 0);
    const done = scans.length >= needed;

    const imei = scanInput({ placeholder: 'Scan device IMEI / serial', label: 'Device IMEI', onScan: v => scanDevice(v) });
    imei.disabled = readOnly || done || (pickup && sh.pickup_state !== 'not_ready');

    async function scanDevice(v: string) {
      slot.replaceChildren();
      imei.disabled = true;
      try {
        const r = await call('shipping.scan', { ...key, imei: v });
        render({ ...d, ...r }, message('ok', `Verified ${v} → ${r.lastScan?.mapped_sku || ''}${r.previousShipments?.length ? '. Note: this IMEI has shipped before.' : ''}`));
      } catch (err) {
        const e = err as ApiError;
        imei.disabled = false; imei.value = ''; imei.focus();
        slot.replaceChildren(message('error', e.message || 'Scan failed.'));
        if (e.data?.code === 'not_found' && e.data?.scanEvent?.id) slot.append(overrideForm(v, e.data.scanEvent.id));
      }
    }

    function overrideForm(v: string, scanEventId: string) {
      const sku = h('select', {}, h('option', { value: '' }, 'Choose the product this device is'), serialProducts.map(p => h('option', { value: p.sku }, `${p.sku} — ${p.name}`)));
      const reason = h('textarea', { rows: 2, placeholder: 'What did you check? (at least 10 characters)' });
      const go = h('button', { type: 'button', class: 'btn btn-danger' }, 'Override with PIN');
      go.addEventListener('click', async () => {
        if (!sku.value || reason.value.trim().length < 10) { slot.append(message('error', 'Choose the product and explain the manual check.')); return; }
        const pin = await askPin('Manual IMEI override', 'This is recorded against your name and shown to managers.');
        if (!pin) return;
        await busy(go, async () => {
          try {
            const r = await call('shipping.override', { ...key, imei: v, scanEventId, claimedSku: sku.value, overrideReason: reason.value.trim(), pin });
            render({ ...d, ...r }, message('warn', `Override recorded for ${v}.`));
          } catch (err) { slot.append(message('error', (err as Error).message)); }
        });
      });
      return h('div', { class: 'card stack' }, h('strong', {}, 'Device not in grading records'), h('p', { class: 'muted small' }, 'Only override after physically checking the model, storage and colour against the order.'), sku, reason, h('div', { class: 'row end' }, go));
    }

    async function act(action: 'print' | 'ship' | 'pickup_ready' | 'collect', button: HTMLButtonElement) {
      slot.replaceChildren();
      if (action !== 'print') {
        const label = action === 'ship' ? 'Ship this order?' : action === 'collect' ? 'Mark as collected?' : 'Tell the customer it is ready?';
        if (!(await confirmDialog(label, 'This updates Cin7 and notifies the customer where the order is linked to Shopify.', 'Confirm'))) return;
      }
      await busy(button, async () => {
        try {
          const r = await call(`shipping.${action}`, key);
          if (action === 'print') {
            if (r.labels?.length) openLabels(r.labels);
            render({ ...d, ...r }, message('ok', `Label ready. Tracking ${r.shipment?.tracking_number || ''}.`));
            return;
          }
          const lines = [`${r.orderName || sh.order_name}${r.cin7OrderNumber ? ' · ' + r.cin7OrderNumber : ''}`];
          if (action === 'ship') lines.push(`Shipped with tracking ${r.trackingNumber}.`, r.notification?.note || (r.emailNotificationRequested ? 'Customer email requested.' : ''));
          else lines.push(action === 'collect' ? 'Collected in store.' : 'Customer told the order is ready for pickup.');
          if (r.note) lines.push(r.note);
          await ctx.completed(action === 'ship' ? 'Order shipped' : action === 'collect' ? 'Order collected' : 'Ready for pickup', lines.filter(Boolean));
        } catch (err) { slot.replaceChildren(message('error', (err as Error).message)); }
      });
    }

    const buttons: HTMLElement[] = [];
    if (!readOnly) {
      if (pickup) {
        if (sh.pickup_state === 'not_ready') { const b = h('button', { type: 'button', class: 'btn btn-primary btn-lg', disabled: !done }, 'Notify ready for pickup'); b.onclick = () => act('pickup_ready', b); buttons.push(b); }
        if (sh.pickup_state === 'ready') { const b = h('button', { type: 'button', class: 'btn btn-primary btn-lg' }, 'Mark collected'); b.onclick = () => act('collect', b); buttons.push(b); }
      } else {
        const p = h('button', { type: 'button', class: 'btn btn-lg', disabled: !done || !key.salesOrderNumber }, sh.tracking_number ? 'Reprint label' : 'Print label'); p.onclick = () => act('print', p); buttons.push(p);
        const s = h('button', { type: 'button', class: 'btn btn-primary btn-lg', disabled: !done || !sh.tracking_number }, 'Ship'); s.onclick = () => act('ship', s); buttons.push(s);
      }
    }

    mount(work,
      h('section', { class: 'card stack' },
        h('div', { class: 'device-head' },
          h('div', {}, h('h2', {}, sh.order_name || sh.cin7_order_number || 'Order'), h('div', { class: 'muted' }, [sh.cin7_order_number, sh.customer_name].filter(Boolean).join(' · '))),
          h('span', { class: 'chip' }, pickup ? `Pickup · ${sh.fulfillment_status || ''}` : sh.fulfillment_status || '')),
        sh.shipping_address?.length && !pickup ? h('p', { class: 'muted small' }, sh.shipping_address.join(', ')) : null,
        sh.label_issue ? message('warn', sh.label_issue) : null,
        sh.status_message ? message('info', sh.status_message) : null,
        h('div', { class: 'table-wrap' }, h('table', { class: 'lines' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Product'), h('th', { class: 'num' }, 'Qty'), h('th', {}, 'Verified'))),
          h('tbody', {}, products.map(p => {
            const got = scans.filter(s => s.scanned_sku === p.sku);
            const serial = serialProducts.includes(p);
            return h('tr', {}, h('td', {}, p.name, h('span', { class: 'muted small mono' }, p.sku)), h('td', { class: 'num' }, p.quantity),
              h('td', {}, serial ? (got.length ? got.map(s => h('div', { class: 'mono small' }, s.scanned_imei, s.validation_method === 'manual_not_found' ? ' (override)' : '')) : h('span', { class: 'muted' }, `0 of ${p.quantity}`)) : h('span', { class: 'muted' }, 'No serial needed')));
          })))),
        needed ? h('div', { class: 'field' }, h('span', { class: 'label' }, `Devices verified ${scans.length} of ${needed}`), imei) : message('info', 'No devices to scan on this order.'),
        slot,
        h('div', { class: 'row end wrap' }, h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => { mount(work); scan.focus(); } }, 'Close'), buttons)));
    if (!imei.disabled && needed) setTimeout(() => imei.focus());
  }

  setTimeout(() => scan.focus());
  return h('div', { class: 'stack' }, h('section', { class: 'card' }, h('h1', {}, 'Shipping'), scan, status), work);
}
