import { act } from '@testing-library/react';
import { pendingCrypto } from '../helpers/pending-crypto.ts';

/** Real time a failing `eventually` keeps trying after its turns, for real timers of the app. */
const MIN_WAIT_MS = 2_000;

/**
 * Returns what `read` returns once it stops throwing. After each failed try the app gets one
 * turn of the event loop inside `act()`, so React finishes every render that turn caused
 * before `read` runs again.
 *
 * `findBy…` waits by the clock: one second, then it fails. The first render of a fleet of
 * 100 wallets takes about a second of processor time in jsdom, so on a busy machine the
 * second ran out before the render did (BUNNDLY-65). Here the bound is a number of turns: a
 * slow machine makes each turn longer, not the wait shorter.
 *
 * A turn is a setImmediate, not a setTimeout(0): on Windows one setTimeout(0) waits for the
 * system timer, about 15–17 ms (BUNNDLY-75). A turn while WebCrypto is still running does not
 * count. So that a real timer of the app (a debounce) can still fire, `read` fails only after
 * its turns and at least 2 s of real time.
 */
export async function eventually<T>(read: () => T, turns = 100): Promise<T> {
  const start = performance.now();
  for (let turn = 0; ;) {
    try {
      return read();
    } catch (error) {
      if (turn >= turns && performance.now() - start >= MIN_WAIT_MS) throw error;
    }
    await act(async () => {
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
    });
    if (pendingCrypto() === 0) turn++;
  }
}
