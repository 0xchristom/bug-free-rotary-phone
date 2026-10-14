import { fillOf, fleetPart } from './fill.ts';
import type { BuyRow } from './use-buy.ts';

/**
 * Filter tabs, search and sorting of the wallet table (SPEC 11.2, mockup v2). One place for
 * what "in flight", "filled" and "needs attention" mean, so the fill bar (BUNNDLY-56) can
 * take it over.
 */
export type WalletFilter = 'all' | 'selected' | 'flight' | 'filled' | 'attention';

export const WALLET_FILTERS: readonly { readonly key: WalletFilter; readonly label: string }[] = [
  { key: 'all', label: 'All wallets' },
  { key: 'selected', label: 'Selected' },
  { key: 'flight', label: 'In flight' },
  { key: 'filled', label: 'Filled' },
  { key: 'attention', label: 'Needs attention' },
];

export interface FilterWallet {
  readonly selected: boolean;
  /** The wallet's progress in the current or last buy, or null. */
  readonly buy: BuyRow | null;
  /** The amount set leaves less than the minimum reserve. */
  readonly reserveTooLow: boolean;
  /** Selected in an armed group, waiting for the creator's token (BUNNDLY-88). */
  readonly armed: boolean;
}

/**
 * Still on its way, exactly as Fleet fill counts it (BUNNDLY-88): scheduled, queued,
 * quoting, signing, sent, the chain being checked or read. One rule in `fleetPart`.
 */
export function inFlight(buy: BuyRow | null): boolean {
  if (buy === null) return false;
  // DRY-RUN and the side change only how an end looks, never whether it is still on its way.
  return fleetPart(fillOf({ ...buy, dryRun: false, side: 'buy' })) === 'inFlight';
}

/** Bought and the token balance grew on the chain: nothing less counts as filled. */
export function filled(buy: BuyRow | null): boolean {
  return buy?.state === 'CONFIRMED' && (buy.verify === 'MATCH' || buy.verify === 'INCREASED');
}

/** Something the user should look at: a failure, an unknown end, a skip or a bad amount. */
export function needsAttention(w: FilterWallet): boolean {
  const buy = w.buy;
  if (buy === null || inFlight(buy)) return w.reserveTooLow;
  switch (buy.state) {
    case 'FAILED':
    case 'UNKNOWN':
      return true;
    case 'SKIPPED':
      return buy.reason?.code !== 'DRY_RUN' || w.reserveTooLow;
    case 'CONFIRMED':
      return buy.verify === 'MISMATCH' || buy.verify === 'NO_INCREASE' || w.reserveTooLow;
    default:
      return w.reserveTooLow;
  }
}

export function matchesFilter(filter: WalletFilter, w: FilterWallet): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'selected':
      return w.selected;
    case 'flight':
      return w.buy === null ? w.armed : inFlight(w.buy);
    case 'filled':
      return filled(w.buy);
    case 'attention':
      return needsAttention(w);
  }
}

/** The query in the name or the address, case-insensitive; an empty query matches all. */
export function matchesSearch(query: string, label: string, address: string): boolean {
  const q = query.trim().toLowerCase();
  return q === '' || label.toLowerCase().includes(q) || address.toLowerCase().includes(q);
}

export type SortKey = 'wallet' | 'balance' | 'amount' | 'tokens' | 'fill';

export interface Sort {
  readonly key: SortKey;
  /** 1 ascending, -1 descending. */
  readonly dir: 1 | -1;
}

export const DEFAULT_SORT: Sort = { key: 'wallet', dir: 1 };

/**
 * The next sort after a click on a column: the same column turns the order around; another
 * one starts with the largest value first, the wallet column with the first wallet.
 */
export function nextSort(current: Sort, key: SortKey): Sort {
  if (current.key === key) return { key, dir: current.dir === 1 ? -1 : 1 };
  return { key, dir: key === 'wallet' ? 1 : -1 };
}

export interface SortWallet {
  readonly index: number;
  /** The value of each sortable column; null (not read, not set) always goes last. */
  readonly balance: bigint | null;
  readonly amount: bigint | null;
  readonly tokens: bigint | null;
  /** The Fill bar's percent (BUNNDLY-92); null before the wallet's first buy or sell. */
  readonly fill: bigint | null;
}

/** Wallet indices in the order of the sort; ties keep the wallet order. */
export function sortWallets(wallets: readonly SortWallet[], sort: Sort): number[] {
  const value = (w: SortWallet): bigint | null =>
    sort.key === 'wallet' ? BigInt(w.index) : w[sort.key];
  return [...wallets]
    .sort((a, b) => {
      const x = value(a);
      const y = value(b);
      if (x === null || y === null) {
        if (x !== y) return x === null ? 1 : -1;
        return a.index - b.index;
      }
      if (x !== y) return (x < y ? -1 : 1) * sort.dir;
      return a.index - b.index;
    })
    .map((w) => w.index);
}
