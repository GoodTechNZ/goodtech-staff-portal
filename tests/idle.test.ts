import { describe, it, expect } from 'vitest';
import { IdleTimer, IDLE_MS } from '../src/idle.ts';

describe('IdleTimer', () => {
  it('expires after 10 minutes without activity and warns in the last minute', () => {
    let t = 0;
    const timer = new IdleTimer(() => t);
    t = IDLE_MS - 61_000;
    expect(timer.state().warn).toBe(false);
    t = IDLE_MS - 30_000;
    expect(timer.state()).toMatchObject({ warn: true, expired: false });
    t = IDLE_MS;
    expect(timer.state().expired).toBe(true);
  });
  it('activity resets the clock', () => {
    let t = 0;
    const timer = new IdleTimer(() => t);
    t = IDLE_MS - 1000;
    timer.activity();
    t = IDLE_MS + 60_000;
    expect(timer.state().expired).toBe(false);
  });
  it('tells the server about activity at most once a minute', () => {
    let t = 0;
    const timer = new IdleTimer(() => t);
    t = 10_000; timer.activity();
    expect(timer.shouldTouch()).toBe(false);
    t = 61_000;
    expect(timer.shouldTouch()).toBe(true);
    expect(timer.shouldTouch()).toBe(false);
    t = 200_000;
    expect(timer.shouldTouch()).toBe(false); // no new activity since the last touch
  });
});
