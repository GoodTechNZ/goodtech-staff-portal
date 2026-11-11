// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { scanInput } from '../src/ui.ts';

function type(input: HTMLInputElement, text: string, msPerChar: number, paste = false) {
  for (const c of paste ? [text] : [...text]) {
    input.value += c;
    input.dispatchEvent(new InputEvent('input', { inputType: paste ? 'insertFromPaste' : 'insertText' }));
    vi.advanceTimersByTime(msPerChar);
  }
}

describe('scan auto-submit', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('submits a scanner-speed scan without Enter, once', () => {
    const onScan = vi.fn();
    const input = scanInput({ placeholder: '', onScan, auto: true }) as HTMLInputElement;
    type(input, 'C02XK1ABJG5H', 5);
    vi.advanceTimersByTime(200);
    expect(onScan).toHaveBeenCalledWith('C02XK1ABJG5H');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(onScan).toHaveBeenCalledTimes(1);
  });

  it('never submits typed or pasted input by itself', () => {
    const onScan = vi.fn();
    const input = scanInput({ placeholder: '', onScan, auto: true }) as HTMLInputElement;
    type(input, '356442166605598', 150);
    vi.advanceTimersByTime(1000);
    expect(onScan).not.toHaveBeenCalled();
    input.value = '';
    type(input, 'SO67458', 0, true);
    vi.advanceTimersByTime(1000);
    expect(onScan).not.toHaveBeenCalled();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(onScan).toHaveBeenCalledWith('SO67458');
  });

  it('is off unless asked for', () => {
    const onScan = vi.fn();
    const input = scanInput({ placeholder: '', onScan }) as HTMLInputElement;
    type(input, '356442166605598', 1);
    vi.advanceTimersByTime(500);
    expect(onScan).not.toHaveBeenCalled();
  });

});
