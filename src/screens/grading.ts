import { call, ApiError, uuid, J } from '../api.ts';
import { h, mount, message, scanInput, segmented, askPin, busy, nzTime } from '../ui.ts';
import {
  TESTS, DESTINATIONS, GradingForm, Grade, Destination, TestResult, emptyForm, formFromRecord, problems,
  suggestedDestination, primaryAction, payload,
} from '../grading.ts';
import type { ScreenCtx } from '../main.ts';

type Lookup = {
  needsSelection?: boolean; serial?: string; candidates?: { recordId: string; row: number | null; grade: string; location: string; tester: string; status: string }[];
  device: { serial: string; recordId: string | null; version: string; row: number | null; model: string; supplier?: string; shipment?: string; capacity?: string; colour?: string };
  record: J; sync: string;
};

const SYNC_LABEL: Record<string, string> = {
  pending: 'Waiting to write to sheet', working: 'Writing to sheet', synced: 'In sheet', conflict: 'Sheet conflict — manager review', linked: 'Linked to existing row',
};

export function gradingScreen(ctx: ScreenCtx): HTMLElement {
  const status = h('div', { class: 'status-slot' });
  const work = h('div', { class: 'stack' });
  const recent = h('aside', { class: 'card recent' }, h('h3', {}, 'My recent devices'), h('p', { class: 'muted small' }, 'Loading…'));
  const scan = scanInput({ placeholder: 'Scan serial / IMEI', label: 'Device serial or IMEI', onScan: v => lookup(v) });

  async function lookup(serial: string, recordId?: string) {
    status.replaceChildren();
    scan.disabled = true;
    try {
      const r = await call<Lookup>('grading.lookup', { serial, recordId });
      if (r.needsSelection) chooseRow(r);
      else showForm(r);
    } catch (err) {
      status.replaceChildren(message('error', err instanceof ApiError ? err.message : 'Lookup failed.'));
      mount(work);
    } finally {
      scan.disabled = false; scan.value = '';
    }
  }

  function chooseRow(r: Lookup) {
    mount(work, h('section', { class: 'card stack' },
      h('h2', {}, `${r.serial} is in the sheet more than once`),
      h('p', { class: 'muted' }, 'Choose the row this device belongs to.'),
      h('div', { class: 'list' }, (r.candidates || []).map(c => h('button', { type: 'button', class: 'list-item', onclick: () => lookup(r.serial!, c.recordId) },
        h('strong', {}, c.row ? `Row ${c.row}` : 'Not yet in sheet'), ` · Grade ${c.grade || '—'} · ${c.location || 'no location'} · ${c.tester || 'no tester'}`,
        c.status ? h('div', { class: 'muted small' }, c.status) : null)))));
  }

  function showForm(r: Lookup) {
    const d = r.device;
    const existing = d.recordId ? r.record : null;
    const existingGrade = String(existing?.grade ?? '');
    const f: GradingForm = existing ? formFromRecord(existing, d.colour || '') : emptyForm(d.colour || r.record?.colour || '');
    const formStatus = h('div', { class: 'status-slot' });
    let lastAttempt: { body: string; saveId: string } | null = null;
    let destinationTouched = !!f.destination;

    const gradeSeg = segmented<Grade>({ name: 'Grade', options: ['1', '2', '3'], value: f.grade, className: 'seg-xl', labels: { '1': 'Grade 1', '2': 'Grade 2', '3': 'Grade 3' }, onChange: v => { f.grade = v; refresh(); } });
    const colour = h('input', { type: 'text', value: f.colour, maxLength: 150, oninput: () => { f.colour = colour.value; refresh(); } });
    const battery = h('input', { type: 'text', inputMode: 'numeric', value: f.battery, maxLength: 3, placeholder: '0–100', oninput: () => { f.battery = battery.value; refresh(); } });
    const statusText = h('textarea', { rows: 2, maxLength: 1000, placeholder: 'Required when a test fails', oninput: () => { f.status = statusText.value; refresh(); } }, f.status);
    const notes = h('textarea', { rows: 2, maxLength: 5000, oninput: () => { f.notes = notes.value; } }, f.notes);
    const destSeg = segmented<Destination>({ name: 'Destination', options: DESTINATIONS, value: f.destination, labels: { 'Ready For Sale': 'Ready For Sale (Cabinet)' }, onChange: v => { f.destination = v; destinationTouched = true; refresh(); } });

    const testSegs = TESTS.map(t => {
      const seg = segmented<TestResult>({ name: t, options: ['Pass', 'Fail', 'Not applicable'], value: f.tests[t] || '', labels: { 'Not applicable': 'N/A' }, className: 'seg-test', onChange: v => { f.tests[t] = v; refresh(); } });
      return { t, seg, row: h('div', { class: 'test-row' }, h('span', { class: 'test-name' }, t), seg) };
    });
    const allPass = h('button', { type: 'button', class: 'btn btn-sm', onclick: () => {
      for (const { t, seg } of testSegs) if (!f.tests[t]) { f.tests[t] = 'Pass'; seg.set('Pass'); }
      refresh();
    } }, 'Mark remaining as Pass');

    const problemsBox = h('ul', { class: 'problems' });
    const primary = h('button', { type: 'button', class: 'btn btn-primary btn-lg' });
    const secondary = h('button', { type: 'button', class: 'btn btn-lg', hidden: true });
    primary.addEventListener('click', () => submit(primaryAction(d.recordId, existingGrade, f.grade), primary));
    secondary.addEventListener('click', () => submit('update', secondary));

    function refresh() {
      if (!destinationTouched) { const s = suggestedDestination(f); if (s !== f.destination) { f.destination = s; destSeg.set(s); } }
      const act = primaryAction(d.recordId, existingGrade, f.grade);
      const issues = act === 'link' ? (f.grade ? [] : ['Select a grade.']) : problems(f);
      problemsBox.replaceChildren(...issues.map(p => h('li', {}, p)));
      const where = d.row ? `row ${d.row}` : 'existing record';
      primary.textContent = act === 'save' ? 'Save to Grading sheet' : act === 'link' ? `Same grade — link to ${where}` : f.grade ? `Update ${where} to grade ${f.grade}` : `Update ${where}`;
      primary.disabled = issues.length > 0;
      secondary.hidden = act !== 'link';
      secondary.textContent = `Update ${where} with these results`;
      secondary.disabled = problems(f).length > 0;
      for (const { t, row } of testSegs) row.classList.toggle('fail', f.tests[t] === 'Fail');
    }

    async function submit(act: 'save' | 'link' | 'update', button: HTMLButtonElement) {
      formStatus.replaceChildren();
      let pin: string | null = null;
      if (act === 'update') {
        pin = await askPin('Change an existing grading record', `This overwrites ${d.row ? 'row ' + d.row : 'the existing record'} in the Grading sheet${existingGrade ? ` (currently grade ${existingGrade})` : ''}.`);
        if (!pin) return;
      }
      await busy(button, async () => {
        try {
          let r: J;
          if (act === 'link') {
            r = await call('grading.link', { serial: d.serial, recordId: d.recordId, grade: f.grade });
          } else {
            const record = payload(f);
            const key = JSON.stringify([d.serial, d.recordId, d.version, record]);
            if (lastAttempt?.body !== key) lastAttempt = { body: key, saveId: uuid() };
            r = await call('grading.save', {
              serial: d.serial, saveId: lastAttempt.saveId, version: act === 'update' ? d.version : '0',
              recordId: act === 'update' ? d.recordId : null, record, pin,
            });
          }
          const lines = [`${d.model} · ${d.serial}`, `Grade ${f.grade}${f.destination && !r.linked ? ' → ' + f.destination : ''}`];
          if (r.linked) lines.push(`Already in the Grading sheet${r.linkedRow ? ' at row ' + r.linkedRow : ''}${r.linkedTester ? ' (' + r.linkedTester + ')' : ''}. Linked, nothing duplicated.`);
          else lines.push('Queued for the Grading tab in ASNs DB.');
          await ctx.completed(r.linked ? 'Linked to existing row' : act === 'update' ? 'Record updated' : 'Device graded', lines);
        } catch (err) {
          formStatus.replaceChildren(message('error', err instanceof ApiError ? err.message : 'Save failed. Try again.'));
        }
      });
    }

    const meta = [d.shipment && `Shipment ${d.shipment}`, d.supplier, d.capacity].filter(Boolean).join(' · ');
    mount(work,
      h('section', { class: 'card device' },
        h('div', { class: 'device-head' },
          h('div', {}, h('h2', {}, d.model || 'Device'), h('div', { class: 'mono' }, d.serial), meta ? h('div', { class: 'muted small' }, meta) : null),
          existing ? h('span', { class: 'chip chip-' + r.sync }, SYNC_LABEL[r.sync] || r.sync) : h('span', { class: 'chip' }, 'New')),
        existing ? message('warn', `Already graded${d.row ? ' (sheet row ' + d.row + ')' : ''}: grade ${existingGrade || '—'} by ${existing.tester || 'unknown'}${existing.date ? ' on ' + existing.date : ''}${existing.location ? ', ' + existing.location : ''}. Grade it yourself — if you agree, it links to that row; a different grade updates it with your PIN.`) : null),
      h('section', { class: 'card stack' },
        h('div', { class: 'field' }, h('span', { class: 'label' }, 'Grade'), gradeSeg),
        h('div', { class: 'row wrap' },
          h('label', { class: 'field grow' }, h('span', { class: 'label' }, 'Colour'), colour),
          h('label', { class: 'field w-sm' }, h('span', { class: 'label' }, 'Battery %'), battery)),
        h('div', { class: 'field' }, h('div', { class: 'row between' }, h('span', { class: 'label' }, 'Functional tests'), allPass), h('div', { class: 'tests' }, testSegs.map(x => x.row))),
        h('label', { class: 'field' }, h('span', { class: 'label' }, 'Device status'), statusText),
        h('div', { class: 'field' }, h('span', { class: 'label' }, 'Destination'), destSeg),
        h('label', { class: 'field' }, h('span', { class: 'label' }, 'Notes'), notes),
        problemsBox, formStatus,
        h('div', { class: 'row end wrap' }, h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => { mount(work); scan.focus(); } }, 'Cancel'), secondary, primary)));
    refresh();
    gradeSeg.querySelector('button')?.focus();
  }

  async function loadRecent() {
    try {
      const r = await call<{ jobs: J[] }>('grading.recent');
      mount(recent, h('h3', {}, 'My recent devices'),
        r.jobs.length ? h('ul', { class: 'recent-list' }, r.jobs.map(j => h('li', {},
          h('span', { class: 'mono' }, j.serial || '—'), h('span', {}, `G${j.grade || '?'}`),
          h('span', { class: 'chip chip-' + j.status, title: j.error || '' }, SYNC_LABEL[j.status] || j.status),
          h('span', { class: 'muted small' }, nzTime(j.createdAt))))) : h('p', { class: 'muted small' }, 'Nothing yet today.'));
    } catch { mount(recent, h('h3', {}, 'My recent devices'), h('p', { class: 'muted small' }, 'Unavailable.')); }
  }
  loadRecent();
  setTimeout(() => scan.focus());

  return h('div', { class: 'layout-side' },
    h('div', { class: 'stack' }, h('section', { class: 'card' }, h('h1', {}, 'Grading'), scan, status), work),
    recent);
}
