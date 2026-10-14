import userEvent, { type UserEvent } from '@testing-library/user-event';

/**
 * `userEvent.setup()` without the pause after every keystroke.
 *
 * By default user-event waits for a `setTimeout(0)` after each key. One such timer takes
 * about 15.6 ms on Windows, so typing the 77 characters of a valid wizard form took 1.4 s,
 * and several times more on a busy machine, up to the 5 s limit of a test (BUNNDLY-64).
 * With `delay: null` the keys follow each other without a timer. Every key still dispatches
 * its events and React still renders after each one.
 *
 * The pause was also the turn in which React ran the effects of the previous step. Without
 * it a click can arrive before them, so a test that depends on what an effect does waits
 * for that state (`waitFor`, `findBy…`) before it clicks.
 */
export function setupUser(): UserEvent {
  return userEvent.setup({ delay: null });
}

/**
 * Pastes a whole value (an address, a key, a password) into a field, as a user does.
 *
 * Typing it key by key renders the whole screen after every key: a 44-character address
 * cost about 13 ms of processor time per key, and a test typing four of them ran out of
 * the 5 s limit on a busy machine (BUNNDLY-75). Tests of what happens while typing keep
 * `user.type`.
 */
export async function enter(user: UserEvent, field: HTMLElement, value: string): Promise<void> {
  await user.click(field);
  await user.paste(value);
}
