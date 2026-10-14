/**
 * What the status rail knows about the last chain read (BUNNDLY-54). The balance poll
 * reports it; the shell shows the data source and how long the read took.
 */
import { createContext, useContext } from 'react';
import type { FeedState } from '../chain/balance-stream.ts';
import type { VaultBalances } from '../worker/protocol.ts';

export interface RpcRead {
  /** `fallback`: Helius failed and the public RPC answered. */
  readonly source: VaultBalances['source'];
  /** From the request to the vault until its answer, measured in the UI. */
  readonly ms: number;
}

export type ReportRpcRead = (read: RpcRead) => void;

/** Outside the app shell (component tests) a report goes nowhere. */
export const RpcReadContext = createContext<ReportRpcRead>(() => undefined);

export function useReportRpcRead(): ReportRpcRead {
  return useContext(RpcReadContext);
}

/**
 * Where the balances on screen come from (BUNNDLY-57): `live` from the account
 * subscriptions, `polling` from periodic reads; null while no screen reads balances.
 */
export type ReportBalanceFeed = (state: FeedState | null) => void;

/** The words for it, in the rail and above the balance column. */
export const FEED_LABELS: Readonly<Record<FeedState, string>> = {
  live: 'Live',
  polling: 'Polling',
};

export const BalanceFeedContext = createContext<ReportBalanceFeed>(() => undefined);

export function useReportBalanceFeed(): ReportBalanceFeed {
  return useContext(BalanceFeedContext);
}
