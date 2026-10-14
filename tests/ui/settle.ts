import { act } from '@testing-library/react';

/**
 * Returns what `read` returns once it stops throwing. After each failed try the app gets one
 * turn of the event loop inside `act()`, so React finishes every render that turn caused
 * before `read` runs again.
 *
 * `findBy…` waits by the clock: one second, then it fails. The first render of a fleet of
 * 100 wallets takes about a second of processor time in jsdom, so on a busy machine the
 * second ran out before the render did (BUNNDLY-65). Here the bound is a number of turns: a
 * slow machine makes each turn longer, not the wait shorter.
 */
export async function eventually<T>(read: () => T, turns = 100): Promise<T> {
  for (let turn = 0; ; turn++) {
    try {
      return read();
    } catch (error) {
      if (turn >= turns) throw error;
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}
