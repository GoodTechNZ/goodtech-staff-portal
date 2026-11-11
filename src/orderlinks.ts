import { call, J } from './api.ts';
import { h } from './ui.ts';

// Cin7 SO numbers and Shopify order numbers link to the order in Cin7 / Shopify admin (new tab).
// orderRef() renders the number straight away; one batched lookup (dashboard.links) fills in the
// links for everything on screen. Numbers that can't be found stay plain text.

const ORDER_REF = /^(SO\d{3,8}|#\d{3,8})$/i;
const cache = new Map<string, string | null>();
let pending = false;

export const isOrderRef = (v: unknown): boolean => ORDER_REF.test(String(v ?? '').trim());

/** An SO / # number that becomes a link once resolved. Anything else is returned as plain text. */
export function orderRef(ref: unknown, cls = ''): HTMLElement | string {
  const v = String(ref ?? '').trim();
  if (!isOrderRef(v)) return v;
  const a = h('a', { class: ('order-link ' + cls).trim(), 'data-order-ref': v.toUpperCase(), target: '_blank', rel: 'noopener' }, v) as HTMLAnchorElement;
  apply(a);
  schedule();
  return a;
}

function apply(a: HTMLAnchorElement) {
  const url = cache.get(a.dataset.orderRef || '');
  if (url) { a.href = url; a.title = url.includes('shopify') ? 'Open in Shopify' : 'Open in Cin7'; }
}

function schedule() {
  if (pending) return;
  pending = true;
  setTimeout(resolveAll, 30);
}

async function resolveAll() {
  pending = false;
  const anchors = [...document.querySelectorAll<HTMLAnchorElement>('a[data-order-ref]:not([href])')];
  const refs = [...new Set(anchors.map(a => a.dataset.orderRef!).filter(r => !cache.has(r)))];
  if (refs.length) {
    try {
      const r = await call<{ links: J }>('dashboard.links', { refs });
      for (const ref of refs) cache.set(ref, r.links?.[ref] || null);
    } catch { return; /* links are a convenience; leave the numbers as text */ }
  }
  document.querySelectorAll<HTMLAnchorElement>('a[data-order-ref]:not([href])').forEach(apply);
}
