import { auth, call, ApiError, Staff } from '../api.ts';
import { h, mount, message } from '../ui.ts';

export type Person = { id: string; name: string };
export type SignIn = { ok: true; sessionToken: string; staff: Staff; idleSeconds: number };

/** Sign in as this person (name only, no PIN) and keep the new session. Used by the sign-in screen and
 *  the header's switch-user menu. */
export async function signInAs(p: Person): Promise<SignIn> {
  const r = await call<SignIn>('auth.signin', { staffId: p.id });
  auth.setSession(r.sessionToken, r.staff);
  return r;
}

// Tap your name to sign in. No PIN: the manager's PIN is asked only to open Admin or Sales & Ops.
export function signInScreen(onSignedIn: () => void, notice?: string): HTMLElement {
  const body = h('div', { class: 'stack' });
  const card = h('section', { class: 'card narrow signin' }, body);
  const fail = (slot: HTMLElement, err: unknown) =>
    slot.replaceChildren(message('error', err instanceof ApiError ? err.message : 'Something went wrong. Try again.'));

  async function namesStep(note?: string) {
    const status = h('div', { class: 'status-slot' }, note ? message('info', note) : null);
    const heading = () => [h('h1', {}, 'Yo whatssup Gs!'), h('p', { class: 'muted' }, 'Tap your name to sign in.'), status];
    mount(body, ...heading(), h('p', { class: 'muted small' }, 'Loading…'));
    try {
      const r = await call<{ staff: Person[] }>('auth.staff');
      mount(body, ...heading(), h('div', { class: 'name-grid' }, r.staff.map(p => {
        const b = h('button', { type: 'button', class: 'btn btn-name' }, p.name);
        b.onclick = async () => {
          body.querySelectorAll('button').forEach(x => { (x as HTMLButtonElement).disabled = true; });
          status.replaceChildren(message('info', `Signing in as ${p.name}…`));
          try { await signInAs(p); onSignedIn(); }
          catch (err) { fail(status, err); body.querySelectorAll('button').forEach(x => { (x as HTMLButtonElement).disabled = false; }); }
        };
        return b;
      })));
    } catch (err) {
      fail(status, err);
      body.append(h('button', { type: 'button', class: 'btn', onclick: () => namesStep() }, 'Try again'));
    }
  }

  namesStep(notice);
  return h('main', { class: 'center' }, card);
}
