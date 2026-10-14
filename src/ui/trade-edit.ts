/**
 * Trade parameters edited in the wallet table and in Settings (SPEC 11.3, BUNNDLY-71): the
 * text of the fields, and a change for some wallets turned into the next `maxSpend` and
 * `trade` for `saveSettings`. Ranges are checked with the rules the worker uses (D-019,
 * D-045); the worker checks them again.
 */
import type { MaxSpendV1 } from '../core/keystore/format.ts';
import {
  TRADE_LIMITS,
  isPriorityFeeSetting,
  isSlippageSetting,
  isTradePercent,
  type BuyAmount,
  type TradeSettingsV1,
  type WalletTradeV1,
} from '../core/trade.ts';
import { percentBuyAmount } from '../executor/buy-plan.ts';
import { parsePercent } from './fleet-math.ts';
import { formatSol, parseSolAmount } from './sol.ts';

/** Under a field the user cannot change during a run, and after the worker refused it. */
export const LOCKED_HINT = 'Can be changed after the run finishes or after STOP.';

/** A wallet's own value removed: it takes the fleet default again. */
export const DEFAULT = 'default';

/**
 * A change for one or more wallets. An absent key keeps the wallet's value; `DEFAULT`
 * removes its own value; `null` (slippage, fee) is Auto.
 */
export interface WalletPatch {
  readonly amount?: BuyAmount | typeof DEFAULT;
  readonly sellPercent?: number | typeof DEFAULT;
  readonly buySlippageBps?: number | null | typeof DEFAULT;
  readonly sellSlippageBps?: number | null | typeof DEFAULT;
  readonly buyPriorityFeeLamports?: bigint | null | typeof DEFAULT;
  readonly sellPriorityFeeLamports?: bigint | null | typeof DEFAULT;
}

type OwnKey = Exclude<keyof WalletTradeV1, 'index' | 'buyPercent'>;
const OWN_KEYS: readonly OwnKey[] = [
  'sellPercent',
  'buySlippageBps',
  'sellSlippageBps',
  'buyPriorityFeeLamports',
  'sellPriorityFeeLamports',
];

/**
 * The next `maxSpend` and `trade` after the patch for the listed wallets. A SOL amount goes
 * to `maxSpend` and drops the percent; a percent drops the `maxSpend` entry (D-045: never
 * both). A wallet left with no own value has no `trade` entry.
 */
export function applyWalletPatch(
  maxSpend: readonly MaxSpendV1[],
  trade: TradeSettingsV1,
  indices: readonly number[],
  patch: WalletPatch,
): { maxSpend: MaxSpendV1[]; trade: TradeSettingsV1 } {
  const spend = new Map(maxSpend.map((m) => [m.index, m.lamports]));
  const own = new Map<number, Map<string, unknown>>(
    trade.wallets.map((w) => [w.index, new Map(Object.entries(w))]),
  );
  for (const index of indices) {
    const entry = own.get(index) ?? new Map<string, unknown>([['index', index]]);
    if (patch.amount !== undefined) {
      entry.delete('buyPercent');
      spend.delete(index);
      if (patch.amount !== DEFAULT) {
        if (patch.amount.kind === 'lamports') spend.set(index, patch.amount.lamports);
        else entry.set('buyPercent', patch.amount.percent);
      }
    }
    for (const key of OWN_KEYS) {
      const value = patch[key];
      if (value === undefined) continue;
      if (value === DEFAULT) entry.delete(key);
      else entry.set(key, value);
    }
    own.set(index, entry);
  }
  const wallets = [...own.entries()]
    .filter(([, w]) => w.size > 1)
    .sort(([a], [b]) => a - b)
    .map(([, w]) => Object.fromEntries(w) as unknown as WalletTradeV1);
  return {
    maxSpend: [...spend]
      .sort(([a], [b]) => a - b)
      .map(([index, lamports]) => ({ index, lamports })),
    trade: { fleet: trade.fleet, wallets },
  };
}

/** The wallet's own amount: its `maxSpend` entry or its percent, else null (the default). */
export function ownAmount(
  trade: TradeSettingsV1,
  index: number,
  maxSpend: bigint | undefined,
): BuyAmount | null {
  if (maxSpend !== undefined) return { kind: 'lamports', lamports: maxSpend };
  const percent = trade.wallets.find((w) => w.index === index)?.buyPercent;
  return percent === undefined ? null : { kind: 'percent', percent };
}

/**
 * What the wallet would spend now: a SOL amount as it is, a percent of the balance read
 * last (as the executor counts it at the start of a run), null without either.
 */
export function plannedSpend(
  amount: BuyAmount | null,
  balance: bigint | null,
  minReserve: bigint,
): bigint | null {
  if (amount === null) return null;
  if (amount.kind === 'lamports') return amount.lamports;
  return balance === null ? null : percentBuyAmount(balance, amount.percent, minReserve);
}

export function amountText(amount: BuyAmount | null): string {
  if (amount === null) return '';
  return amount.kind === 'lamports' ? formatSol(amount.lamports) : String(amount.percent);
}

export function amountLabel(amount: BuyAmount | null): string {
  if (amount === null) return 'none';
  return amount.kind === 'lamports'
    ? `${formatSol(amount.lamports)} SOL`
    : `${String(amount.percent)} % of balance`;
}

export function slippageLabel(bps: number | null): string {
  if (bps === null) return 'Auto';
  return `${String(bps / 100)} %`;
}

export function feeLabel(lamports: bigint | null): string {
  return lamports === null ? 'Auto' : `${formatSol(lamports)} SOL`;
}

/** The text of a slippage field for a saved value: empty for the default, "auto" or a percent. */
export function slippageText(bps: number | null | undefined): string {
  if (bps === undefined) return '';
  return bps === null ? 'auto' : String(bps / 100);
}

export type Parsed<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string };

const MESSAGES = {
  percent: 'Enter a whole number from 1 to 100.',
  slippage: `Enter Auto or a slippage from ${String(TRADE_LIMITS.slippageBps.min / 100)} to ${String(TRADE_LIMITS.slippageBps.max / 100)} % (at most 2 decimal places).`,
  fee: 'Enter Auto or a fee of more than 0 and at most 0.1 SOL.',
} as const;

function isAuto(text: string): boolean {
  return text.trim().toLowerCase() === 'auto';
}

/** A buy amount field: empty = the fleet default, else SOL or a whole percent. */
export function parseAmount(text: string, unit: 'SOL' | '%'): Parsed<BuyAmount | typeof DEFAULT> {
  if (text.trim() === '') return { ok: true, value: DEFAULT };
  if (unit === '%') {
    const n = /^\d{1,3}$/u.test(text.trim()) ? Number(text.trim()) : Number.NaN;
    return isTradePercent(n)
      ? { ok: true, value: { kind: 'percent', percent: n } }
      : { ok: false, message: MESSAGES.percent };
  }
  const parsed = parseSolAmount(text);
  if (!parsed.ok) return { ok: false, message: parsed.message };
  return { ok: true, value: { kind: 'lamports', lamports: parsed.lamports } };
}

/** A slippage field: empty = the fleet default, "auto" = Auto, else a percent → bps. */
export function parseSlippage(text: string): Parsed<number | null | typeof DEFAULT> {
  if (text.trim() === '') return { ok: true, value: DEFAULT };
  if (isAuto(text)) return { ok: true, value: null };
  const bps = parsePercent(text);
  return bps !== null && isSlippageSetting(bps)
    ? { ok: true, value: bps }
    : { ok: false, message: MESSAGES.slippage };
}

/** The sell part: empty = the fleet default, else a whole percent. */
export function parseSellPercent(text: string): Parsed<number | typeof DEFAULT> {
  if (text.trim() === '') return { ok: true, value: DEFAULT };
  const n = /^\d{1,3}$/u.test(text.trim()) ? Number(text.trim()) : Number.NaN;
  return isTradePercent(n) ? { ok: true, value: n } : { ok: false, message: MESSAGES.percent };
}

/** A priority fee: empty = the fleet default, "auto" = Auto, else SOL → lamports. */
export function parseFee(text: string): Parsed<bigint | null | typeof DEFAULT> {
  if (text.trim() === '') return { ok: true, value: DEFAULT };
  if (isAuto(text)) return { ok: true, value: null };
  const parsed = parseSolAmount(text);
  return parsed.ok && isPriorityFeeSetting(parsed.lamports)
    ? { ok: true, value: parsed.lamports }
    : { ok: false, message: MESSAGES.fee };
}
