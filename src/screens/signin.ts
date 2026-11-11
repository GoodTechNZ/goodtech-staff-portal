import { auth, call, ApiError, Staff } from '../api.ts';
import { h, mount, message, pinPad } from '../ui.ts';

type Person = { id: string; name: string; hasPin: boolean; noPin?: boolean };
type SignIn = { ok: true; sessionToken: string; staff: Staff; idleSeconds: number };

// Pick your name, then enter your 4-digit PIN. First time: set a PIN (entered twice).
export function signInScreen(onSignedIn: () => void, notice?: string): HTMLElement {
  const body = h('div', { class: 'stack' });
  const card = h('section', { class: 'card narrow signin' }, body);

  const finish = (r: SignIn) => { auth.setSession(r.sessionToken, r.staff); onSignedIn(); };
  const fail = (slot: HTMLElement, err: unknown) =>
    slot.replaceChildren(message('error', err instanceof ApiError ? err.message : 'Something went wrong. Try again.'));

  async function namesStep(note?: string) {
    const status = h('div', { class: 'status-slot' }, note ? message('info', note) : null);
    mount(body, h('h1', {}, 'Who are you?'), h('p', { class: 'muted' }, 'Tap your name to sign in.'), status, h('p', { class: 'muted small' }, 'Loading…'));
    try {
      const r = await call<{ staff: Person[] }>('auth.staff');
      mount(body, h('h1', {}, 'Who are you?'), h('p', { class: 'muted' }, 'Tap your name to sign in.'), status,
        h('div', { class: 'name-grid' }, r.staff.map(p => h('button', { type: 'button', class: 'btn btn-name', onclick: () => p.noPin ? signInNoPin(p) : p.hasPin ? pinStep(p) : newPinStep(p) }, p.name))));
    } catch (err) {
      fail(status, err);
      body.append(h('button', { type: 'button', class: 'btn', onclick: () => namesStep() }, 'Try again'));
    }
  }

  function back() { return h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => namesStep() }, 'Not you? Back to names'); }

  // This person's own device (no PIN): one tap signs in.
  async function signInNoPin(p: Person) {
    const status = h('div', { class: 'status-slot' }, message('info', `Signing in as ${p.name}…`));
    mount(body, status);
    try { finish(await call<SignIn>('auth.signin', { staffId: p.id })); }
    catch (err) { fail(status, err); body.append(back()); }
  }

  function pinStep(p: Person) {
    const status = h('div', { class: 'status-slot' });
    const pad = pinPad({
      label: 'Enter your 4-digit PIN',
      onComplete: async pin => {
        try { finish(await call<SignIn>('auth.signin', { staffId: p.id, pin })); }
        catch (err) { fail(status, err); pad.reset(); pad.focusPad(); }
      },
    });
    mount(body, h('h1', {}, `Hi ${p.name}`), pad, status, back());
    setTimeout(() => pad.focusPad());
  }

  function newPinStep(p: Person) {
    const status = h('div', { class: 'status-slot' });
    let first = '';
    const label = (t: string) => { pad.querySelector('.pin-label')!.textContent = t; };
    const pad = pinPad({
      label: 'Choose a 4-digit PIN',
      onComplete: async pin => {
        if (!first) { first = pin; label('Enter the same PIN again'); status.replaceChildren(); return; }
        if (pin !== first) { first = ''; label('Choose a 4-digit PIN'); status.replaceChildren(message('error', 'The PINs did not match. Start again.')); return; }
        try { finish(await call<SignIn>('auth.signin', { staffId: p.id, newPin: pin })); }
        catch (err) { first = ''; label('Choose a 4-digit PIN'); fail(status, err); pad.reset(); }
      },
    });
    mount(body, h('h1', {}, `${p.name}, set your PIN`),
      h('p', { class: 'muted' }, 'First time here. Choose 4 digits you will remember (not 1234, 0000 or similar). Keep it to yourself — you also use it to confirm sensitive actions.'),
      pad, status, back());
    setTimeout(() => pad.focusPad());
  }

  namesStep(notice);
  return h('main', { class: 'center' }, card);
}
