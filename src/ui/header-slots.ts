/**
 * Places in the top bar that the Dashboard fills (BUNNDLY-73, mockup v2): the DRY-RUN
 * switch before the network switch and the fleet balance after it. The Dashboard owns
 * what they need (the settings save and the balance reads), so it renders them there
 * through a portal; on other screens the bar shows the run mode as a plain chip.
 *
 * `say` is in the status rail at the bottom: the line where the Dashboard says what a
 * command just did (BUNNDLY-90, the mockup's `say()`).
 */
import { createContext, useContext } from 'react';

export interface HeaderSlots {
  readonly mode: HTMLElement | null;
  readonly balance: HTMLElement | null;
  readonly say: HTMLElement | null;
}

export const NO_SLOTS: HeaderSlots = { mode: null, balance: null, say: null };

export const HeaderSlotsContext = createContext<HeaderSlots>(NO_SLOTS);

export function useHeaderSlots(): HeaderSlots {
  return useContext(HeaderSlotsContext);
}
