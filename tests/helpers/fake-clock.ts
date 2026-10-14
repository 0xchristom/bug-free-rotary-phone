/** Manual clock for executor and limiter tests: time moves only when a test runs it. */
import type { LimiterClock } from '../../src/executor/limiter.ts';
import { pendingCrypto } from './pending-crypto.ts';

export const T0 = 1_790_000_000_000; // ms, a realistic Unix time

/** Manual clock: sleep() resolves only when the test advances time. */
export class FakeClock implements LimiterClock {
  private t = T0;
  private timers: { at: number; resolve: () => void }[] = [];

  /**
   * `fast`: settle with three setImmediate turns, for long simulations of pure logic.
   * Otherwise settle also waits until no WebCrypto call is running (the vault's signing
   * finishes on a thread pool, outside the microtask queue).
   */
  constructor(private readonly fast = false) {}

  now(): number {
    return this.t;
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.timers.push({ at: this.t + Math.max(0, ms), resolve });
    });
  }

  /**
   * Lets every resolved promise run before time moves on: a real macrotask turn drains
   * the whole microtask queue, however many hops a pipeline needs.
   *
   * The turns are setImmediate, not setTimeout(0): on Windows one setTimeout(0) waits for
   * the system timer, about 15–17 ms, which made a 2 h simulation take 22 s (BUNNDLY-75).
   * Without `fast` it ends only after three quiet turns with no WebCrypto call running.
   */
  async settle(): Promise<void> {
    for (let quiet = 0; quiet < 3;) {
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
      quiet = this.fast || pendingCrypto() === 0 ? quiet + 1 : 0;
    }
  }

  /** Runs timers in order until `until` (inclusive) or until none are left. */
  async runUntil(until = Number.POSITIVE_INFINITY): Promise<void> {
    await this.settle();
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (next === undefined || next.at > until) break;
      this.timers.shift();
      this.t = Math.max(this.t, next.at);
      next.resolve();
      await this.settle();
    }
    if (until !== Number.POSITIVE_INFINITY) this.t = Math.max(this.t, until);
    await this.settle();
  }
}
