import { auth, call, ApiError, uuid, J } from '../api.ts';
import { deviceCodePanel } from './codechange.ts';
import { h, mount, message, scanInput, segmented, askPin, busy, nzTime } from '../ui.ts';
import {
  TESTS, DESTINATIONS, GradingForm, Grade, Destination, TestResult, emptyForm, formFromRecord, problems,
  suggestedDestination, primaryAction, payload, cleanColour, colourEditable,
} from '../grading.ts';
import type { ScreenCtx } from '../main.ts';

type Lookup = {
  needsSelection?: boolean; serial?: string; candidates?: { recordId: string; row: number | null; grade: string; location: string; tester: string; status: string }[];
  device: { serial: string; recordId: string | null; version: string; row: number | null; model: string; supplier?: string; shipment?: string; capacity?: string; colour?: string; listedColour?: string };
  record: J; sync: string;
  graded?: boolean; canMove?: boolean;
  sheet?: { row: number; grade: string; colour: string | null; status: string | null; location: string | null; tester: string | null; productCode: string | null } | null;
};

const SYNC_LABEL: Record<string, string> = {
  pending: 'Waiting to write to sheet', working: 'Writing to sheet', synced: 'In sheet', conflict: 'Sheet conflict — manager review', linked: 'Linked to existing row', dismissed: 'In sheet',
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
      else if (r.graded) showGraded(r);
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

  // Graded devices are never graded again. Staff can move them and update the status note; grade,
  // colour and model changes are product-code changes that move stock in Cin7 (manager process).
  function showGraded(r: Lookup) {
    const d = r.device;
    const rec = r.record || {};
    const sh = r.sheet;
    const grade = sh?.grade || String(rec.grade ?? '');
    const colour = sh?.colour || String(rec.colour ?? '');
    const tester = sh?.tester || String(rec.tester ?? '');
    const row = sh?.row ?? d.row;
    const currentDest: Destination | '' = (DESTINATIONS as readonly string[]).includes(String(rec.destination)) ? rec.destination as Destination
      : rec.location === 'Cabinet' ? 'Ready For Sale' : (DESTINATIONS as readonly string[]).includes(String(rec.location)) ? rec.location as Destination : '';
    const initial = { destination: currentDest, status: String(rec.status ?? ''), notes: String(rec.notes ?? '') };
    const next: { destination: Destination | ''; status: string; notes: string } = { ...initial };
    const formStatus = h('div', { class: 'status-slot' });
    let attempt: { key: string; moveId: string } | null = null;

    const facts = [
      `Grade ${grade || '—'}`, colour && colour, tester && `by ${tester}`, rec.date && `on ${rec.date}`,
      (sh?.location || rec.location) && `· ${sh?.location || rec.location}`,
    ].filter(Boolean).join(' ');
    const head = h('section', { class: 'card device' },
      h('div', { class: 'device-head' },
        h('div', {}, h('h2', {}, d.model || 'Device'), h('div', { class: 'mono' }, d.serial),
          h('div', { class: 'muted small' }, [row ? `Sheet row ${row}` : null, sh?.productCode && sh.productCode !== '-' ? sh.productCode : null].filter(Boolean).join(' · '))),
        h('span', { class: 'chip chip-synced' }, 'Already graded')),
      message('info', `${facts}.${(sh?.status || rec.status) ? ' Status: ' + (sh?.status || rec.status) + '.' : ''} It can't be graded again.`));

    // Grade, colour and model corrections are product-code changes (Cin7 stock moves): managers only.
    const wrongGrade = h('div', { class: 'stack' });
    const showWrongGrade = () => mount(wrongGrade, auth.staff?.role === 'manager' && d.recordId
      ? h('div', { class: 'row between wrap' }, h('span', { class: 'muted small' }, 'Wrong grade, colour or model?'),
          h('button', { type: 'button', class: 'btn btn-sm', onclick: () => mount(wrongGrade, deviceCodePanel({ serial: d.serial, recordId: d.recordId! }, showWrongGrade)) }, 'Change product code'))
      : h('p', { class: 'muted small' }, 'Wrong grade, colour or model? That changes the product code and moves the stock in Cin7, so ask a manager.'));
    showWrongGrade();

    if (!r.canMove) {
      mount(work, head, h('section', { class: 'card stack' },
        message('warn', d.recordId
          ? 'An earlier change to this device hasn’t reached the sheet yet, or has a conflict. Ask Fraser to clear it (Dashboard → Grading sync), then scan again.'
          : `Graded in the sheet${row ? ' (row ' + row + ')' : ''}, but the portal hasn’t loaded that row yet. Change its location in the sheet for now.`),
        wrongGrade,
        h('div', { class: 'row end' }, h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => { mount(work); scan.focus(); } }, 'Done'))));
      return;
    }

    const destSeg = segmented<Destination>({ name: 'Location', options: DESTINATIONS, value: next.destination, labels: { 'Ready For Sale': 'Ready For Sale (Cabinet)' }, onChange: v => { next.destination = v; refresh(); } });
    const statusText = h('textarea', { rows: 2, maxLength: 1000, placeholder: 'e.g. Screen replaced, needs unlocking', oninput: () => { next.status = statusText.value; refresh(); } }, next.status);
    const notes = h('textarea', { rows: 2, maxLength: 5000, oninput: () => { next.notes = notes.value; refresh(); } }, next.notes);
    const save = h('button', { type: 'button', class: 'btn btn-primary btn-lg' }, 'Save changes');
    const hint = h('div', { class: 'muted small' });

    function refresh() {
      const changed = next.destination !== initial.destination || next.status.trim() !== initial.status.trim() || next.notes !== initial.notes;
      save.disabled = !changed || !next.destination;
      save.textContent = next.destination !== initial.destination ? `Move to ${next.destination}` : 'Save changes';
      hint.textContent = changed ? '' : 'Choose a new location or change the status to save.';
    }

    save.addEventListener('click', () => busy(save, async () => {
      formStatus.replaceChildren();
      const body = { serial: d.serial, recordId: d.recordId, version: d.version, destination: next.destination, status: next.status.trim(), notes: next.notes };
      const key = JSON.stringify(body);
      if (attempt?.key !== key) attempt = { key, moveId: uuid() };
      try {
        const res = await call<J>('grading.move', { ...body, moveId: attempt.moveId });
        const moved = res.from !== res.to;
        await ctx.completed(moved ? 'Device moved' : 'Status updated', [
          `${d.model} · ${d.serial}`,
          moved ? `${res.from || 'Unknown'} → ${res.to}` : `Status: ${next.status.trim() || '(cleared)'}`,
          'Queued for the Grading tab in ASNs DB — usually there within 1–3 minutes.',
        ]);
      } catch (err) {
        formStatus.replaceChildren(message('error', err instanceof ApiError ? err.message : 'Save failed. Try again.'));
      }
    }));

    mount(work, head, h('section', { class: 'card stack' },
      h('h3', {}, 'Move or update status'),
      h('div', { class: 'field' }, h('span', { class: 'label' }, 'Location'), destSeg),
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Device status'), statusText),
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Notes'), notes),
      formStatus, hint,
      h('div', { class: 'row end wrap' }, h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => { mount(work); scan.focus(); } }, 'Cancel'), save),
      wrongGrade));
    refresh();
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
    // Colour: the supplier's listed colour is used as-is unless the tester changes it. A typed
    // colour is only required when the supplier didn't list one (X).
    const listed = cleanColour(d.listedColour ?? d.colour);
    if (!cleanColour(f.colour)) f.colour = listed;
    let editingColour = colourEditable(listed, f.colour);
    const colour = h('input', { type: 'text', value: f.colour, maxLength: 150, placeholder: listed ? '' : 'Not listed by supplier — enter the colour', 'aria-label': 'Colour', oninput: () => { f.colour = colour.value; refresh(); } });
    const colourField = h('div', { class: 'field grow' });
    function renderColour() {
      const label = h('span', { class: 'label' }, 'Colour');
      if (!editingColour) {
        colourField.replaceChildren(label, h('div', { class: 'row colour-listed' },
          h('strong', {}, listed), h('span', { class: 'muted small' }, 'from supplier'),
          h('button', { type: 'button', class: 'btn btn-sm', onclick: () => { editingColour = true; renderColour(); colour.focus(); colour.select(); } }, 'Change')));
        return;
      }
      colour.value = f.colour;
      const hint = listed
        ? h('div', { class: 'row small' }, h('span', { class: 'muted' }, `Supplier lists ${listed}.`),
            h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: () => { f.colour = listed; editingColour = false; renderColour(); refresh(); } }, 'Use supplier colour'))
        : h('span', { class: 'muted small' }, 'Supplier colour is X — enter the colour.');
      colourField.replaceChildren(label, colour, hint);
    }
    renderColour();
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
              recordId: act === 'update' ? d.recordId : null, record, pin, listedColour: listed,
            });
          }
          const lines = [`${d.model} · ${d.serial}`, `Grade ${f.grade}${f.destination && !r.linked ? ' → ' + f.destination : ''}`];
          if (r.linked) lines.push(`Already in the Grading sheet${r.linkedRow ? ' at row ' + r.linkedRow : ''}${r.linkedTester ? ' (' + r.linkedTester + ')' : ''}. Linked, nothing duplicated.`);
          else lines.push('Queued for the Grading tab in ASNs DB — usually there within 1–3 minutes.');
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
        h('div', { class: 'row wrap top' },
          colourField,
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
