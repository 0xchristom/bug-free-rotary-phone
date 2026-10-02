import { useCallback, useEffect, useRef, useState } from 'react';
import { toUserMessage } from '../core/errors.ts';
import type { VaultBalances } from '../worker/protocol.ts';
import type { VaultClient } from '../worker/vault-client.ts';

/** SPEC 3.2: every 10–15 s. Each refresh costs Helius credits (D-020). */
export const DEFAULT_BALANCE_REFRESH_MS = 12_000;

export interface BalancesState {
  readonly lamports: ReadonlyMap<number, bigint> | null;
  readonly source: VaultBalances['source'] | null;
  readonly fetchedAt: string | null;
  readonly error: string | null;
}

const EMPTY: BalancesState = { lamports: null, source: null, fetchedAt: null, error: null };

function visible(): boolean {
  return document.visibilityState === 'visible';
}

/**
 * Periodic SOL balance reads through the vault worker. Runs only while the component is
 * mounted (the fleet screen exists only with an unlocked fleet) and the tab is visible;
 * a tab coming back to view refreshes at once. One request at a time.
 */
export function useBalances(
  client: VaultClient,
  intervalMs: number = DEFAULT_BALANCE_REFRESH_MS,
): BalancesState & { readonly refresh: () => void } {
  const [state, setState] = useState<BalancesState>(EMPTY);
  const inflight = useRef(false);
  const mounted = useRef(true);

  const refresh = useCallback(() => {
    if (inflight.current || !visible()) return;
    inflight.current = true;
    client.request({ type: 'refreshBalances' }).then(
      (res) => {
        inflight.current = false;
        if (!mounted.current) return;
        setState({
          lamports: new Map(res.balances.map((b) => [b.index, b.lamports])),
          source: res.source,
          fetchedAt: res.fetchedAt,
          error: null,
        });
      },
      (e: unknown) => {
        inflight.current = false;
        if (!mounted.current) return;
        setState((s) => ({ ...s, error: toUserMessage(e) }));
      },
    );
  }, [client]);

  useEffect(() => {
    mounted.current = true;
    refresh();
    const timer = setInterval(refresh, intervalMs);
    const onVisibility = (): void => {
      if (visible()) refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refresh, intervalMs]);

  return { ...state, refresh };
}
