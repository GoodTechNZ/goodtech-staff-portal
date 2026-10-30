// Idle sign-out: 10 minutes without a tap, key press or scan ends the session. The server
// applies the same limit; activity is reported to it at most once a minute so a long form
// does not expire server-side while someone is working on it.

export const IDLE_MS = 10 * 60 * 1000;
export const WARN_MS = 60 * 1000;
export const TOUCH_EVERY_MS = 60 * 1000;

export type IdleState = { remainingMs: number; warn: boolean; expired: boolean };

export class IdleTimer {
  private lastActivity: number;
  private lastTouch: number;
  constructor(private now: () => number = Date.now, private idleMs = IDLE_MS, private warnMs = WARN_MS) {
    this.lastActivity = now();
    this.lastTouch = now();
  }
  activity() { this.lastActivity = this.now(); }
  /** True when the server should be told about recent activity. */
  shouldTouch(): boolean {
    const t = this.now();
    if (this.lastActivity > this.lastTouch && t - this.lastTouch >= TOUCH_EVERY_MS) { this.lastTouch = t; return true; }
    return false;
  }
  serverContact() { this.lastTouch = this.now(); }
  state(): IdleState {
    const remainingMs = Math.max(0, this.idleMs - (this.now() - this.lastActivity));
    return { remainingMs, warn: remainingMs > 0 && remainingMs <= this.warnMs, expired: remainingMs === 0 };
  }
}
