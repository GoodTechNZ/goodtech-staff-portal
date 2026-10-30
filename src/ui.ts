// Small DOM helpers: no framework, the screens are simple forms driven by scanners.

type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = Record<string, any>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el && typeof v !== 'string') (el as any)[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function mount(target: HTMLElement, ...children: Child[]) {
  target.replaceChildren();
  append(target, children);
}

export function message(kind: 'error' | 'ok' | 'info' | 'warn', text: string) {
  return h('div', { class: `msg msg-${kind}`, role: kind === 'error' ? 'alert' : 'status' }, text);
}

/** Text input that fires onScan when a scanner (or person) presses Enter. */
export function scanInput(opts: { placeholder: string; onScan: (v: string) => void; type?: string; label?: string; id?: string }) {
  const input = h('input', {
    class: 'scan', type: opts.type || 'text', placeholder: opts.placeholder, autocomplete: 'off', autocapitalize: 'off',
    spellcheck: false, id: opts.id, 'aria-label': opts.label || opts.placeholder,
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = input.value.trim();
      if (v) opts.onScan(v);
    }
  });
  return input;
}

export function segmented<T extends string>(opts: { options: readonly T[]; value: T | ''; onChange: (v: T) => void; labels?: Partial<Record<T, string>>; name: string; className?: string }) {
  const wrap = h('div', { class: 'seg ' + (opts.className || ''), role: 'radiogroup', 'aria-label': opts.name });
  const buttons = opts.options.map(o => {
    const b = h('button', { type: 'button', role: 'radio', class: 'seg-btn', 'data-value': o }, opts.labels?.[o] ?? o);
    b.addEventListener('click', () => { set(o); opts.onChange(o); });
    return b;
  });
  function set(v: T | '') {
    for (const b of buttons) {
      const on = b.dataset.value === v;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', String(on));
    }
  }
  set(opts.value);
  wrap.append(...buttons);
  return Object.assign(wrap, { set });
}

/** On-screen PIN pad. Also accepts digits from the keyboard. Resolves with 4 digits. */
export function pinPad(opts: { onComplete: (pin: string) => void; label?: string }) {
  let pin = '';
  const dots = h('div', { class: 'pin-dots', 'aria-live': 'polite' });
  const render = () => {
    dots.replaceChildren(...[0, 1, 2, 3].map(i => h('span', { class: 'dot' + (i < pin.length ? ' on' : '') })));
    dots.setAttribute('aria-label', `${pin.length} of 4 digits entered`);
  };
  const press = (d: string) => {
    if (d === 'del') pin = pin.slice(0, -1);
    else if (d === 'clr') pin = '';
    else if (pin.length < 4) pin += d;
    render();
    if (pin.length === 4) { const p = pin; pin = ''; setTimeout(() => { render(); opts.onComplete(p); }, 120); }
  };
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clr', '0', 'del'];
  const pad = h('div', { class: 'pin-pad' }, keys.map(k => h('button', {
    type: 'button', class: 'pin-key' + (k.length > 1 ? ' pin-fn' : ''), onclick: () => press(k),
    'aria-label': k === 'del' ? 'Delete' : k === 'clr' ? 'Clear' : k,
  }, k === 'del' ? '⌫' : k === 'clr' ? 'Clear' : k)));
  const keyHandler = (e: KeyboardEvent) => {
    if (/^\d$/.test(e.key)) { e.preventDefault(); press(e.key); }
    else if (e.key === 'Backspace') { e.preventDefault(); press('del'); }
    else if (e.key === 'Escape') { press('clr'); }
  };
  const el = h('div', { class: 'pin', tabindex: '0' }, opts.label ? h('div', { class: 'pin-label' }, opts.label) : null, dots, pad);
  el.addEventListener('keydown', keyHandler);
  render();
  return Object.assign(el, { reset: () => { pin = ''; render(); }, focusPad: () => el.focus() });
}

/** Modal asking for the PIN again before a sensitive action. Resolves null if cancelled. */
export function askPin(title: string, detail?: string): Promise<string | null> {
  return new Promise(resolve => {
    const close = (v: string | null) => { overlay.remove(); resolve(v); };
    const pad = pinPad({ onComplete: pin => close(pin), label: 'Enter your PIN to confirm' });
    const overlay = h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'dialog' },
        h('h2', {}, title),
        detail ? h('p', { class: 'muted' }, detail) : null,
        pad,
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => close(null) }, 'Cancel')));
    overlay.addEventListener('keydown', e => { if (e.key === 'Escape') close(null); });
    document.body.appendChild(overlay);
    pad.focusPad();
  });
}

export function confirmDialog(title: string, detail: string, confirmLabel = 'Confirm', danger = false): Promise<boolean> {
  return new Promise(resolve => {
    const close = (v: boolean) => { overlay.remove(); resolve(v); };
    const ok = h('button', { type: 'button', class: 'btn ' + (danger ? 'btn-danger' : 'btn-primary'), onclick: () => close(true) }, confirmLabel);
    const overlay = h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'dialog' }, h('h2', {}, title), h('p', {}, detail),
        h('div', { class: 'row end' }, h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => close(false) }, 'Cancel'), ok)));
    overlay.addEventListener('keydown', e => { if (e.key === 'Escape') close(false); });
    document.body.appendChild(overlay);
    ok.focus();
  });
}

/** Full-screen confirmation shown after a completed device/order, before returning to sign in. */
export function doneSplash(title: string, lines: string[], ms = 2600): Promise<void> {
  return new Promise(resolve => {
    const overlay = h('div', { class: 'overlay done', role: 'status' },
      h('div', { class: 'dialog done-card' }, h('div', { class: 'done-tick', 'aria-hidden': 'true' }, '✓'), h('h2', {}, title),
        lines.map(l => h('p', {}, l)), h('p', { class: 'muted' }, 'Signed out. Scan your badge for the next one.')));
    document.body.appendChild(overlay);
    const finish = () => { overlay.remove(); resolve(); };
    overlay.addEventListener('click', finish);
    setTimeout(finish, ms);
  });
}

export function busy<T>(button: HTMLButtonElement | null, run: () => Promise<T>): Promise<T> {
  if (button) { button.disabled = true; button.classList.add('loading'); }
  return run().finally(() => { if (button) { button.disabled = false; button.classList.remove('loading'); } });
}

export function nzTime(iso?: string | null) {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-NZ', { timeZone: 'Pacific/Auckland', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
}

export function nzToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Auckland', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export function money(n: number) {
  return new Intl.NumberFormat('en-NZ', { style: 'currency', currency: 'NZD' }).format(n);
}
