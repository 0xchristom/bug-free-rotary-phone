/**
 * Shared app state: the vault client (BUNNDLY-7) and its last known status. Screens get
 * them through React context. Nothing here touches storage or the URL (SPEC 6.1).
 */
import { createContext, useContext } from 'react';
import type { VaultClient } from '../worker/vault-client.ts';
import type { VaultStatus } from '../worker/protocol.ts';

export type Screen = 'start' | 'wizard' | 'open' | 'fleet' | 'settings';

/** Screens that need an unlocked fleet. */
export const UNLOCKED_SCREENS: ReadonlySet<Screen> = new Set(['fleet', 'settings']);

export interface VaultState {
  readonly client: VaultClient;
  /** null until the first status reply. */
  readonly status: VaultStatus | null;
  /** Re-reads the status from the worker. */
  readonly refresh: () => Promise<void>;
}

export const VaultContext = createContext<VaultState | null>(null);

export function useVault(): VaultState {
  const state = useContext(VaultContext);
  if (state === null) throw new Error('useVault outside VaultContext');
  return state;
}
