import { h } from '../ui.ts';
import type { ScreenCtx } from '../main.ts';

export function shippingScreen(_ctx: ScreenCtx): HTMLElement {
  return h('section', { class: 'card' }, h('h1', {}, 'Shipping'), h('p', { class: 'muted' }, 'Coming next.'));
}
