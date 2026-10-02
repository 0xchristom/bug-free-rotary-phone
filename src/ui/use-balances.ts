import { useCallback, useEffect, useRef, useState } from 'react';
import { toUserMessage } from '../core/errors.ts';
import type { VaultBalances } from '../worker/protocol.ts';
import type { VaultClient } from '../worker/vault-client.ts';

/** SPEC 3.2: every 10–15 s. Each refresh costs Helius credits (D-020). */
export const DEFAULT_BALANCE_REFRESH_MS = 12_000;

export interface TokenState {
  readonly mint: string;
  readonly program: 'spl-token' | 'token-2022';
  readonly decimals: number;
  readonly amounts: ReadonlyMap<number, bigint>;
}

export interface BalancesState {
  readonly lamports: ReadonlyMap<number, bigint> | null;
  /** Balances of the chosen token, when a mint is set and was read. */
  readonly token: TokenState | null;
  readonly source: VaultBalances['source'] | null;
  readonly fetchedAt: string | null;
  readonly error: string | null;
}

const EMPTY: BalancesState = {
  lamports: null,
  token: null,
  source: null,
  fetchedAt: null,
  error: null,
};

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
  /** Token mint whose balances are read too; null for SOL only. */
  mint: string | null = null,
): BalancesState & { readonly refresh: () => void } {
  const [state, setState] = useState<BalancesState>(EMPTY);
  const inflight = useRef(false);
  const mounted = useRef(true);
  /** A refresh asked for while one was running (e.g. a new mint): run it afterwards. */
  const again = useRef(false);
  const latest = useRef<() => void>(() => undefined);

  const refresh = useCallback(() => {
    if (!visible()) return;
    if (inflight.current) {
      again.current = true;
      return;
    }
    inflight.current = true;
    const done = (): void => {
      inflight.current = false;
      if (again.current && mounted.current) {
        again.current = false;
        latest.current();
      }
    };
    client.request({ type: 'refreshBalances', ...(mint === null ? {} : { mint }) }).then(
      (res) => {
        if (mounted.current) {
          setState({
            lamports: new Map(res.balances.map((b) => [b.index, b.lamports])),
            token: res.token
              ? {
                  mint: res.token.mint,
                  program: res.token.program,
                  decimals: res.token.decimals,
                  amounts: new Map(res.token.balances.map((b) => [b.index, b.amount])),
                }
              : null,
            source: res.source,
            fetchedAt: res.fetchedAt,
            error: null,
          });
        }
        done();
      },
      (e: unknown) => {
        // A wrong mint must not leave the previous token's balances on screen.
        if (mounted.current) setState((s) => ({ ...s, token: null, error: toUserMessage(e) }));
        done();
      },
    );
  }, [client, mint]);

  useEffect(() => {
    latest.current = refresh;
  }, [refresh]);

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
