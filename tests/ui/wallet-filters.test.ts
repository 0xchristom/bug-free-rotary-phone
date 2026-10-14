import { describe, expect, it } from 'vitest';
import type { WalletReason, WalletState } from '../../src/executor/states.ts';
import type { VerifyStatus } from '../../src/executor/verify.ts';
import type { BuyRow } from '../../src/ui/use-buy.ts';
import {
  DEFAULT_SORT,
  matchesFilter,
  matchesSearch,
  nextSort,
  sortWallets,
  type FilterWallet,
  type WalletFilter,
} from '../../src/ui/wallet-filters.ts';

function buy(
  state: WalletState,
  reason: WalletReason | null = null,
  verify: VerifyStatus | null = null,
): BuyRow {
  return { state, attempt: 1, reason, quote: null, result: null, sinceStartMs: 0, verify };
}

const DRY: WalletReason = { kind: 'SKIPPED', code: 'DRY_RUN', detail: null };
const LOW: WalletReason = { kind: 'SKIPPED', code: 'INSUFFICIENT_SOL', detail: null };
const MAX: WalletReason = { kind: 'FAILED', code: 'MAX_ATTEMPTS', detail: null };
const CHECKING: WalletReason = { kind: 'UNKNOWN', code: 'EXECUTE_NO_ANSWER', detail: null };

function wallet(b: BuyRow | null, extra: Partial<FilterWallet> = {}): FilterWallet {
  return { selected: true, buy: b, reserveTooLow: false, ...extra };
}

/** The tabs a wallet shows under, besides "All wallets", in tab order. */
function tabsOf(w: FilterWallet): WalletFilter[] {
  return (['selected', 'flight', 'filled', 'attention'] as const).filter((f) =>
    matchesFilter(f, w),
  );
}

describe('filter tabs', () => {
  // Every case and its tabs written by hand from the decision in BUNNDLY-55 (Plane, 14.10).
  it.each([
    ['no buy yet', wallet(null), ['selected']],
    ['no buy, not selected', wallet(null, { selected: false }), []],
    ['no buy, reserve too low', wallet(null, { reserveTooLow: true }), ['selected', 'attention']],
    ['waiting in a run', wallet(buy('IDLE')), ['selected', 'flight']],
    ['queued', wallet(buy('QUEUED')), ['selected', 'flight']],
    ['quoting', wallet(buy('QUOTING')), ['selected', 'flight']],
    ['signing', wallet(buy('SIGNING')), ['selected', 'flight']],
    ['sent', wallet(buy('SUBMITTED')), ['selected', 'flight']],
    ['sent, chain being checked', wallet(buy('UNKNOWN', CHECKING)), ['selected', 'flight']],
    ['bought, chain MATCH', wallet(buy('CONFIRMED', null, 'MATCH')), ['selected', 'filled']],
    [
      'bought, chain INCREASED',
      wallet(buy('CONFIRMED', null, 'INCREASED')),
      ['selected', 'filled'],
    ],
    ['bought, not read yet', wallet(buy('CONFIRMED')), ['selected']],
    ['bought, UNVERIFIABLE', wallet(buy('CONFIRMED', null, 'UNVERIFIABLE')), ['selected']],
    ['bought, MISMATCH', wallet(buy('CONFIRMED', null, 'MISMATCH')), ['selected', 'attention']],
    [
      'bought, NO_INCREASE',
      wallet(buy('CONFIRMED', null, 'NO_INCREASE')),
      ['selected', 'attention'],
    ],
    ['failed', wallet(buy('FAILED', MAX)), ['selected', 'attention']],
    [
      'unknown, not a pending check',
      wallet(buy('UNKNOWN', { kind: 'UNKNOWN', code: 'LANDING_UNRESOLVED', detail: null })),
      ['selected', 'attention'],
    ],
    ['skipped for lack of SOL', wallet(buy('SKIPPED', LOW)), ['selected', 'attention']],
    ['DRY-RUN', wallet(buy('SKIPPED', DRY)), ['selected']],
    [
      'DRY-RUN, reserve too low',
      wallet(buy('SKIPPED', DRY), { reserveTooLow: true }),
      ['selected', 'attention'],
    ],
  ] as const)('%s', (_name, w, tabs) => {
    expect(matchesFilter('all', w)).toBe(true);
    expect(tabsOf(w)).toEqual(tabs);
  });

  it('a filled wallet is never in flight nor in need of attention at once', () => {
    const w = wallet(buy('CONFIRMED', null, 'MATCH'));
    expect([matchesFilter('flight', w), matchesFilter('attention', w)]).toEqual([false, false]);
  });
});

describe('search', () => {
  it('finds the name or the address, any case; an empty query finds all', () => {
    const address = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    expect(matchesSearch('', 'Wallet 3', address)).toBe(true);
    expect(matchesSearch('   ', 'Wallet 3', address)).toBe(true);
    expect(matchesSearch('wallet 3', 'Wallet 3', address)).toBe(true);
    expect(matchesSearch(' q5da ', 'Wallet 3', address)).toBe(true);
    expect(matchesSearch('kegQ', 'Wallet 3', address)).toBe(true);
    expect(matchesSearch('Wallet 4', 'Wallet 3', address)).toBe(false);
  });
});

describe('sorting', () => {
  const SOL = 1_000_000_000n;
  const wallets = [
    { index: 0, balance: 2n * SOL, amount: null, tokens: 5n },
    { index: 1, balance: null, amount: 100n, tokens: null },
    { index: 2, balance: SOL, amount: 300n, tokens: 5n },
    { index: 3, balance: 3n * SOL, amount: 100n, tokens: 1n },
  ];

  it('the wallet order by default', () => {
    expect(sortWallets(wallets, DEFAULT_SORT)).toEqual([0, 1, 2, 3]);
  });

  it('a value column starts with the largest; null goes last both ways; ties keep the wallet order', () => {
    expect(sortWallets(wallets, { key: 'balance', dir: -1 })).toEqual([3, 0, 2, 1]);
    expect(sortWallets(wallets, { key: 'balance', dir: 1 })).toEqual([2, 0, 3, 1]);
    expect(sortWallets(wallets, { key: 'amount', dir: -1 })).toEqual([2, 1, 3, 0]);
    expect(sortWallets(wallets, { key: 'amount', dir: 1 })).toEqual([1, 3, 2, 0]);
    expect(sortWallets(wallets, { key: 'tokens', dir: -1 })).toEqual([0, 2, 3, 1]);
  });

  it('a click on the same column turns it round; another column starts high, Wallet low', () => {
    expect(nextSort(DEFAULT_SORT, 'wallet')).toEqual({ key: 'wallet', dir: -1 });
    expect(nextSort(DEFAULT_SORT, 'balance')).toEqual({ key: 'balance', dir: -1 });
    expect(nextSort({ key: 'balance', dir: -1 }, 'balance')).toEqual({ key: 'balance', dir: 1 });
    expect(nextSort({ key: 'balance', dir: -1 }, 'wallet')).toEqual({ key: 'wallet', dir: 1 });
  });
});
