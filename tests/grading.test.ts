import { describe, it, expect } from 'vitest';
import { TESTS, emptyForm, formFromRecord, problems, primaryAction, suggestedDestination, GradingForm } from '../src/grading.ts';

function complete(over: Partial<GradingForm> = {}): GradingForm {
  return { ...emptyForm('Black'), grade: '2', destination: 'Ready For Sale', tests: Object.fromEntries(TESTS.map(t => [t, 'Pass'])), ...over };
}

describe('grading form', () => {
  it('is ready when everything is filled in', () => {
    expect(problems(complete())).toEqual([]);
  });
  it('lists what is missing', () => {
    const p = problems(emptyForm(''));
    expect(p).toContain('Select a grade.');
    expect(p).toContain('Enter the colour.');
    expect(p.some(x => x.includes('12 more tests'))).toBe(true);
  });
  it('needs a fault description when a test fails', () => {
    const f = complete({ tests: { ...complete().tests, Charging: 'Fail' } });
    expect(problems(f)).toContain('Describe the fault in Device status.');
    expect(problems({ ...f, status: 'Port loose' })).toEqual([]);
  });
  it('suggests Repairs on any failure', () => {
    expect(suggestedDestination(complete())).toBe('Ready For Sale');
    expect(suggestedDestination(complete({ tests: { ...complete().tests, Display: 'Fail' } }))).toBe('Repairs');
    expect(suggestedDestination(emptyForm())).toBe('');
  });
  it('prefills from the sheet but leaves the grade to the tester', () => {
    const f = formFromRecord({ grade: '1', colour: 'Blue', battery: '87', tests: { Display: 'Pass', Bogus: 'x' }, destination: 'Ready For Sale' }, '');
    expect(f.grade).toBe('');
    expect(f.colour).toBe('Blue');
    expect(f.tests).toEqual({ Display: 'Pass' });
  });
});

describe('existing sheet rows', () => {
  it('saves new devices', () => expect(primaryAction(null, '', '2')).toBe('save'));
  it('links when the grade matches the sheet', () => expect(primaryAction('id', '2', '2')).toBe('link'));
  it('updates when the grade differs', () => expect(primaryAction('id', '2', '3')).toBe('update'));
  it('needs a grade before deciding', () => expect(primaryAction('id', '2', '')).toBe('update'));
});
