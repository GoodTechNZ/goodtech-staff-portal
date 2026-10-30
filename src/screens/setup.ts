import { auth, call, ApiError } from '../api.ts';
import { h, message, busy } from '../ui.ts';

// One-time terminal enrolment. Needs the enrolment code from a manager.
export function setupScreen(onDone: () => void): HTMLElement {
  const status = h('div', { class: 'status-slot' });
  const name = h('input', { type: 'text', placeholder: 'e.g. Grading bench 1', maxLength: 60, required: true, autocomplete: 'off' });
  const code = h('input', { type: 'text', placeholder: 'XXXX-XXXX-XXXX', required: true, autocomplete: 'off', autocapitalize: 'characters', spellcheck: false });
  const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-lg' }, 'Enrol this terminal');
  const form = h('form', { class: 'card narrow stack' },
    h('h1', {}, 'Set up this terminal'),
    h('p', { class: 'muted' }, 'This is done once per shared computer or tablet. Ask a manager for the enrolment code.'),
    h('label', { class: 'field' }, h('span', {}, 'Terminal name'), name),
    h('label', { class: 'field' }, h('span', {}, 'Enrolment code'), code),
    status, submit);
  form.addEventListener('submit', e => {
    e.preventDefault();
    status.replaceChildren();
    busy(submit, async () => {
      try {
        const r = await call<{ terminalToken: string; name: string }>('terminal.enrol', { code: code.value, name: name.value });
        auth.setTerminal({ token: r.terminalToken, name: r.name });
        onDone();
      } catch (err) {
        status.replaceChildren(message('error', err instanceof ApiError ? err.message : 'Enrolment failed.'));
      }
    });
  });
  setTimeout(() => name.focus());
  return h('main', { class: 'center' }, form);
}
