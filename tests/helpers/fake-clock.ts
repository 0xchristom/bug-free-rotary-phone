/** Manual clock for executor and limiter tests: time moves only when a test runs it. */
import type { LimiterClock } from '../../src/executor/limiter.ts';

export const T0 = 1_790_000_000_000; // ms, a realistic Unix time

/** Manual clock: sleep() resolves only when the test advances time. */
export class FakeClock implements LimiterClock {
  private t = T0;
  private timers: { at: number; resolve: () => void }[] = [];

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
   */
  async settle(): Promise<void> {
    for (let i = 0; i < 3; i++) {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
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
