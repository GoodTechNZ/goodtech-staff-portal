import { h } from '../ui.ts';
import type { ScreenCtx } from '../main.ts';

export function salesScreen(_ctx: ScreenCtx): HTMLElement {
  return h('section', { class: 'card' }, h('h1', {}, 'Sales'), h('p', { class: 'muted' }, 'Coming next.'));
}
