import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isAppError, toUserMessage } from '../core/errors.ts';
import { DEFAULT_NETWORK, type Network } from '../core/network.ts';
import type { VaultBalances } from '../worker/protocol.ts';
import type { VaultClient } from '../worker/vault-client.ts';
import type { FeedState } from '../chain/balance-stream.ts';
import { useReportBalanceFeed, useReportRpcRead } from './shell-status.ts';

/** SPEC 3.2: every 10–15 s. Each refresh costs Helius credits (D-020). */
export const DEFAULT_BALANCE_REFRESH_MS = 12_000;
/**
 * While the balances are live (BUNNDLY-57), a full read only reconciles them with the chain:
 * at most this often. Polling keeps the interval above.
 */
export const LIVE_RECONCILE_MS = 30_000;

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
 * SOL balances through the vault worker. Live (BUNNDLY-57, D-055): the worker's account
 * subscriptions change one wallet at a time, and a full read reconciles every 30 s and once
 * each time the feed comes back. Polling (no socket, or not every wallet subscribed): a full
 * read every `intervalMs`. Runs only while the component is mounted (the fleet screen exists
 * only with an unlocked fleet) and the tab is visible; a tab coming back to view refreshes
 * at once. One request at a time.
 */
export function useBalances(
  client: VaultClient,
  intervalMs: number = DEFAULT_BALANCE_REFRESH_MS,
  /** Token mint whose balances are read too; null for SOL only. */
  mint: string | null = null,
  /**
   * Called when the vault says the mint is not a token mint. The caller then drops the
   * mint, so SOL balances keep refreshing until the address is fixed.
   */
  onBadMint?: (message: string) => void,
  /**
   * The open fleet's network. When it changes, the balances on screen are dropped at once
   * and read again; an answer read on another network is never shown (BUNNDLY-44).
   */
  network: Network = DEFAULT_NETWORK,
): BalancesState & { readonly refresh: () => void; readonly feed: FeedState } {
  const [state, setState] = useState<BalancesState>(EMPTY);
  /** Polling until the worker says every wallet is subscribed: never shown live early. */
  const [feed, setFeed] = useState<FeedState>('polling');
  const [shownNetwork, setShownNetwork] = useState(network);
  if (shownNetwork !== network) {
    setShownNetwork(network);
    setState(EMPTY);
    setFeed('polling'); // the worker opens a new socket for the new network
  }
  const reportRead = useReportRpcRead();
  const reportFeed = useReportBalanceFeed();
  const inflight = useRef(false);
  const mounted = useRef(true);
  /** A refresh asked for while one was running (e.g. a new mint): run it afterwards. */
  const again = useRef(false);
  const latest = useRef<() => void>(() => undefined);
  /** The mint shown now; answers for any other mint are stale and dropped. */
  const currentMint = useRef(mint);
  const currentNetwork = useRef(network);

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
    const asked = mint;
    const askedNetwork = network;
    const askedAt = performance.now();
    // The user may change or clear the mint while this request runs. Its answer, success
    // or error, then belongs to a mint no longer on screen and must be ignored; the
    // refresh for the new mint follows right after (`again`).
    const stale = (): boolean =>
      !mounted.current || currentMint.current !== asked || currentNetwork.current !== askedNetwork;
    client.request({ type: 'refreshBalances', ...(asked === null ? {} : { mint: asked }) }).then(
      (res) => {
        // The worker says where it read: the switch may have landed between ask and read.
        if (!stale() && res.network === askedNetwork) {
          reportRead({
            source: res.source,
            ms: Math.round(performance.now() - askedAt),
            at: res.fetchedAt,
          });
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
        if (!stale()) {
          if (asked !== null && isAppError(e) && e.code === 'NOT_A_TOKEN_MINT' && onBadMint) {
            setState((s) => ({ ...s, token: null }));
            onBadMint(toUserMessage(e));
          } else {
            // A failed read must not leave a previous token's balances on screen.
            setState((s) => ({ ...s, token: null, error: toUserMessage(e) }));
          }
        }
        done();
      },
    );
  }, [client, mint, onBadMint, network, reportRead]);

  // A layout effect runs at commit, before any passive effect: no answer arriving between
  // the commit and the effects can be checked against the old mint, and the new mint is
  // current before the polling effect refreshes.
  useLayoutEffect(() => {
    currentMint.current = mint;
    currentNetwork.current = network;
  }, [mint, network]);

  useEffect(() => {
    latest.current = refresh;
  }, [refresh]);

  // A full read now and then periodically. It runs again when the feed changes: going live
  // it is the one reconciliation after the socket came back; going to polling, the first
  // read of the fallback.
  const live = feed === 'live';
  useEffect(() => {
    mounted.current = true;
    refresh();
    const timer = setInterval(refresh, live ? Math.max(intervalMs, LIVE_RECONCILE_MS) : intervalMs);
    const onVisibility = (): void => {
      if (visible()) refresh();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refresh, intervalMs, live]);

  // The worker's account subscriptions while this screen is open.
  useEffect(() => {
    let alive = true;
    client.request({ type: 'balanceFeed', on: true }).then(
      (res) => {
        if (alive && res.network === currentNetwork.current) setFeed(res.state);
      },
      () => undefined, // no feed: the balances keep polling
    );
    return () => {
      alive = false;
      client.request({ type: 'balanceFeed', on: false }).catch(() => undefined);
    };
  }, [client]);

  // One wallet's change at a time: only its row gets a new value (FleetRow is memoized).
  useEffect(
    () =>
      client.onEvent((event) => {
        if (event.kind !== 'balance') return;
        // Network guard (as in BUNNDLY-44): a change read on a network no longer on
        // screen never lands in the table.
        if (event.network !== currentNetwork.current) return;
        if (event.type === 'feed') {
          setFeed(event.state);
        } else if (event.type === 'sol') {
          setState((s) =>
            s.lamports === null || s.lamports.get(event.index) === event.lamports
              ? s // before the first full read there is no row value to change
              : { ...s, lamports: new Map(s.lamports).set(event.index, event.lamports) },
          );
        } else {
          setState((s) =>
            s.token?.mint !== event.mint || s.token.amounts.get(event.index) === event.amount
              ? s
              : {
                  ...s,
                  token: {
                    ...s.token,
                    amounts: new Map(s.token.amounts).set(event.index, event.amount),
                  },
                },
          );
        }
      }),
    [client],
  );

  useEffect(() => {
    reportFeed(feed);
  }, [feed, reportFeed]);
  useEffect(
    () => () => {
      reportFeed(null); // no screen reads balances now
    },
    [reportFeed],
  );

  return { ...state, refresh, feed };
}
