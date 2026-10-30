import { h } from '../ui.ts';
import type { ScreenCtx } from '../main.ts';

export function dashboardScreen(_ctx: ScreenCtx): HTMLElement {
  return h('section', { class: 'card' }, h('h1', {}, 'Dashboard'), h('p', { class: 'muted' }, 'Coming next.'));
}
