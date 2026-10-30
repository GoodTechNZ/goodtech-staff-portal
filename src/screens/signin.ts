import { auth, call, ApiError, Staff } from '../api.ts';
import { h, mount, message, scanInput, pinPad } from '../ui.ts';

type Badge = { state: 'pin' | 'set_pin' | 'claim'; staff?: { id: string; name: string }; unclaimed?: { id: string; name: string }[] };
type SignIn = { ok: true; sessionToken: string; staff: Staff; idleSeconds: number };

// Badge scan, then PIN. First use of a badge: pick your name and set a PIN.
export function signInScreen(onSignedIn: () => void, notice?: string): HTMLElement {
  const body = h('div', { class: 'stack' });
  const card = h('section', { class: 'card narrow signin' }, body);
  let badge = '';

  const finish = (r: SignIn) => {
    auth.setSession(r.sessionToken, r.staff);
    onSignedIn();
  };
  const fail = (slot: HTMLElement, err: unknown) =>
    slot.replaceChildren(message('error', err instanceof ApiError ? err.message : 'Something went wrong. Try again.'));

  function scanStep(note?: string, kind: 'error' | 'info' = 'info') {
    badge = '';
    const status = h('div', { class: 'status-slot' }, note ? message(kind, note) : null);
    const input = scanInput({
      placeholder: 'Scan your staff badge', type: 'password', label: 'Staff badge', id: 'badge',
      onScan: async v => {
        input.disabled = true;
        try {
          const r = await call<Badge>('auth.badge', { badge: v });
          badge = v;
          if (r.state === 'pin') pinStep(r.staff!);
          else if (r.state === 'set_pin') newPinStep(r.staff!, null);
          else claimStep(r.unclaimed || []);
        } catch (err) {
          input.disabled = false; input.value = ''; input.focus();
          fail(status, err);
        }
      },
    });
    mount(body,
      h('div', { class: 'badge-icon', 'aria-hidden': 'true' }, '▤'),
      h('h1', {}, 'Scan your badge'),
      h('p', { class: 'muted' }, 'Hold your staff badge to the scanner to sign in.'),
      input, status);
    setTimeout(() => input.focus());
  }

  function pinStep(staff: { id: string; name: string }) {
    const status = h('div', { class: 'status-slot' });
    const pad = pinPad({
      label: 'Enter your 4-digit PIN',
      onComplete: async pin => {
        try { finish(await call<SignIn>('auth.signin', { badge, pin })); }
        catch (err) { fail(status, err); pad.reset(); pad.focusPad(); }
      },
    });
    mount(body, h('h1', {}, `Hi ${staff.name}`), pad, status,
      h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => scanStep() }, 'Not you? Scan again'));
    setTimeout(() => pad.focusPad());
  }

  function claimStep(names: { id: string; name: string }[]) {
    if (!names.length) return scanStep('This badge is not registered and every staff member already has one. Ask a manager to reset the badge.', 'error');
    mount(body,
      h('h1', {}, 'New badge'),
      h('p', { class: 'muted' }, 'This badge has not been used before. Choose your name. A manager will see that this badge was registered today.'),
      h('div', { class: 'name-grid' }, names.map(n => h('button', { type: 'button', class: 'btn btn-name', onclick: () => newPinStep(n, n.id) }, n.name))),
      h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => scanStep() }, 'Cancel'));
  }

  function newPinStep(staff: { id: string; name: string }, claimStaffId: string | null) {
    const status = h('div', { class: 'status-slot' });
    let first = '';
    const title = h('h1', {}, `${staff.name}, set your PIN`);
    const hint = h('p', { class: 'muted' }, 'Choose 4 digits. Not 1234, 0000 or similar. You will use it to sign in and to confirm sensitive actions.');
    const pad = pinPad({
      label: 'New PIN',
      onComplete: async pin => {
        if (!first) {
          first = pin;
          pad.querySelector('.pin-label')!.textContent = 'Enter the same PIN again';
          status.replaceChildren();
          return;
        }
        if (pin !== first) {
          first = '';
          pad.querySelector('.pin-label')!.textContent = 'New PIN';
          status.replaceChildren(message('error', 'The PINs did not match. Start again.'));
          return;
        }
        try { finish(await call<SignIn>('auth.signin', { badge, newPin: pin, claimStaffId })); }
        catch (err) {
          first = '';
          pad.querySelector('.pin-label')!.textContent = 'New PIN';
          fail(status, err); pad.reset();
        }
      },
    });
    mount(body, title, hint, pad, status, h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => scanStep() }, 'Cancel'));
    setTimeout(() => pad.focusPad());
  }

  scanStep(notice);
  return h('main', { class: 'center' }, card);
}
