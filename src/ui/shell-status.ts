/**
 * What the status rail knows about the last chain read (BUNNDLY-54). The balance poll
 * reports it; the shell shows the data source and how long the read took.
 */
import { createContext, useContext } from 'react';
import type { VaultBalances } from '../worker/protocol.ts';

export interface RpcRead {
  /** `fallback`: Helius failed and the public RPC answered. */
  readonly source: VaultBalances['source'];
  /** From the request to the vault until its answer, measured in the UI. */
  readonly ms: number;
  /** When the worker read the balances (ISO time), shown in the rail (BUNNDLY-73). */
  readonly at: string;
}

export type ReportRpcRead = (read: RpcRead) => void;

/** Outside the app shell (component tests) a report goes nowhere. */
export const RpcReadContext = createContext<ReportRpcRead>(() => undefined);

export function useReportRpcRead(): ReportRpcRead {
  return useContext(RpcReadContext);
}
