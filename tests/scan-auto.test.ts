// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { scanInput } from '../src/ui.ts';
import { completeOrderScan, completeImei } from '../src/screens/shipping.ts';

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

  it('waits for Enter on slow typing unless the value is complete', () => {
    const onScan = vi.fn();
    const input = scanInput({ placeholder: '', onScan, auto: true, complete: completeImei }) as HTMLInputElement;
    type(input, 'C02XK1', 200);
    vi.advanceTimersByTime(500);
    expect(onScan).not.toHaveBeenCalled();
    input.value = '';
    type(input, '35644216660559', 200);
    vi.advanceTimersByTime(500);
    expect(onScan).not.toHaveBeenCalled();
    type(input, '8', 200);
    vi.advanceTimersByTime(200);
    expect(onScan).toHaveBeenCalledWith('356442166605598');
  });

  it('submits a paste', () => {
    const onScan = vi.fn();
    const input = scanInput({ placeholder: '', onScan, auto: true }) as HTMLInputElement;
    type(input, 'SO67458', 0, true);
    vi.advanceTimersByTime(200);
    expect(onScan).toHaveBeenCalledWith('SO67458');
  });

  it('is off unless asked for', () => {
    const onScan = vi.fn();
    const input = scanInput({ placeholder: '', onScan }) as HTMLInputElement;
    type(input, '356442166605598', 1);
    vi.advanceTimersByTime(500);
    expect(onScan).not.toHaveBeenCalled();
  });

  it('knows whole order and IMEI scans', () => {
    expect(completeOrderScan('SO67458')).toBe(true);
    expect(completeOrderScan('so6745')).toBe(false);
    expect(completeOrderScan('00894210392935481314')).toBe(true);
    expect(completeOrderScan('SK051989969NZ')).toBe(true);
    expect(completeImei('356442166605598')).toBe(true);
    expect(completeImei('35644216660559')).toBe(false);
  });
});
