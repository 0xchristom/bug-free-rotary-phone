import userEvent, { type UserEvent } from '@testing-library/user-event';

/**
 * `userEvent.setup()` without the pause after every keystroke.
 *
 * By default user-event waits for a `setTimeout(0)` after each key. One such timer takes
 * about 15.6 ms on Windows, so typing the 77 characters of a valid wizard form took 1.4 s,
 * and several times more on a busy machine, up to the 5 s limit of a test (BUNNDLY-64).
 * With `delay: null` the keys follow each other without a timer. Every key still dispatches
 * its events and React still renders after each one.
 */
export function setupUser(): UserEvent {
  return userEvent.setup({ delay: null });
}
