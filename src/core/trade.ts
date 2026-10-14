/**
 * Trade parameters per wallet with fleet defaults (SPEC 11.3, BUNNDLY-58): buy amount,
 * sell part, slippage and priority fee for each side. Dependency-free, so the form and
 * the vault worker validate with the same rules (D-019).
 *
 * A wallet entry without a field takes the fleet default; `null` is "Auto" (Jupiter or
 * the route picks the value). The SOL buy amount of a wallet stays in `maxSpend` of the
 * fleet settings; a percent amount lives here.
 */

/** Inclusive limits. Slippage in basis points: 10 = 0.1 %, 10000 = 100 %. */
export const TRADE_LIMITS = {
  percent: { min: 1, max: 100 },
  slippageBps: { min: 10, max: 10_000 },
  // A hard ceiling of 0.1 SOL per transaction.
  priorityFeeLamports: { min: 1n, max: 100_000_000n },
} as const;

export type BuyAmount =
  | { readonly kind: 'lamports'; readonly lamports: bigint }
  | { readonly kind: 'percent'; readonly percent: number };

/** Fleet defaults: what a wallet without its own value uses. */
export interface FleetTradeV1 {
  /** null: no default, a wallet without its own amount does not buy. */
  readonly buyAmount: BuyAmount | null;
  readonly sellPercent: number;
  readonly buySlippageBps: number | null;
  readonly sellSlippageBps: number | null;
  readonly buyPriorityFeeLamports: bigint | null;
  readonly sellPriorityFeeLamports: bigint | null;
}

/** A wallet's own values; an absent field means the fleet default. */
export interface WalletTradeV1 {
  readonly index: number;
  /** A percent buy amount; a SOL amount is the wallet's `maxSpend` entry instead. */
  readonly buyPercent?: number;
  readonly sellPercent?: number;
  readonly buySlippageBps?: number | null;
  readonly sellSlippageBps?: number | null;
  readonly buyPriorityFeeLamports?: bigint | null;
  readonly sellPriorityFeeLamports?: bigint | null;
}

export interface TradeSettingsV1 {
  readonly fleet: FleetTradeV1;
  readonly wallets: readonly WalletTradeV1[];
}

/** Defaults: no buy amount, sell everything, Auto everywhere (a file from before). */
export const DEFAULT_TRADE_SETTINGS: TradeSettingsV1 = {
  fleet: {
    buyAmount: null,
    sellPercent: 100,
    buySlippageBps: null,
    sellSlippageBps: null,
    buyPriorityFeeLamports: null,
    sellPriorityFeeLamports: null,
  },
  wallets: [],
};

/** What one wallet trades with, every default applied. */
export interface WalletTrade {
  readonly buyAmount: BuyAmount | null;
  readonly sellPercent: number;
  readonly buySlippageBps: number | null;
  readonly sellSlippageBps: number | null;
  readonly buyPriorityFeeLamports: bigint | null;
  readonly sellPriorityFeeLamports: bigint | null;
}

/**
 * The wallet's own value, else the fleet default. The buy amount: the wallet's SOL
 * amount (`maxSpend` entry) or its percent, else the fleet default amount.
 */
export function walletTrade(
  trade: TradeSettingsV1,
  index: number,
  maxSpendLamports: bigint | undefined,
): WalletTrade {
  const own = trade.wallets.find((w) => w.index === index);
  const f = trade.fleet;
  const buyAmount: BuyAmount | null =
    maxSpendLamports !== undefined
      ? { kind: 'lamports', lamports: maxSpendLamports }
      : own?.buyPercent !== undefined
        ? { kind: 'percent', percent: own.buyPercent }
        : f.buyAmount;
  return {
    buyAmount,
    sellPercent: own?.sellPercent ?? f.sellPercent,
    buySlippageBps: own?.buySlippageBps !== undefined ? own.buySlippageBps : f.buySlippageBps,
    sellSlippageBps: own?.sellSlippageBps !== undefined ? own.sellSlippageBps : f.sellSlippageBps,
    buyPriorityFeeLamports:
      own?.buyPriorityFeeLamports !== undefined
        ? own.buyPriorityFeeLamports
        : f.buyPriorityFeeLamports,
    sellPriorityFeeLamports:
      own?.sellPriorityFeeLamports !== undefined
        ? own.sellPriorityFeeLamports
        : f.sellPriorityFeeLamports,
  };
}

export function isTradePercent(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= TRADE_LIMITS.percent.min &&
    value <= TRADE_LIMITS.percent.max
  );
}

/** A slippage setting: null (Auto) or whole basis points from 10 to 10000. */
export function isSlippageSetting(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= TRADE_LIMITS.slippageBps.min &&
      value <= TRADE_LIMITS.slippageBps.max)
  );
}

/** A priority fee setting: null (Auto) or 1 lamport to 0.1 SOL. */
export function isPriorityFeeSetting(value: unknown): value is bigint | null {
  return (
    value === null ||
    (typeof value === 'bigint' &&
      value >= TRADE_LIMITS.priorityFeeLamports.min &&
      value <= TRADE_LIMITS.priorityFeeLamports.max)
  );
}

export interface TradeProblem {
  /** `fleet.<field>` or `wallet.<index>.<field>`. */
  readonly field: string;
  /** English message for the form. Never contains the entered value. */
  readonly message: string;
}

const MESSAGES = {
  percent: 'The percent must be a whole number from 1 to 100.',
  slippage: 'Slippage must be Auto or from 0.1 to 100 % in steps of 0.01 %.',
  priorityFee: 'The priority fee must be Auto or more than 0 and at most 0.1 SOL.',
  lamports: 'The buy amount must be more than 0 SOL.',
  amountKind: 'The default buy amount must be none, a SOL amount or a percent.',
  twoAmounts: 'A wallet has either a SOL amount or a percent, not both.',
  unknownWallet: 'This wallet is not in the fleet.',
  duplicate: 'This wallet has two entries.',
} as const;

/**
 * Checks ranges and relations. Empty list = valid; the worker refuses anything else
 * (INVALID_SETTINGS). `maxSpendIndices`: wallets with a SOL amount in `maxSpend`.
 */
export function validateTradeSettings(
  trade: TradeSettingsV1,
  walletIndices: ReadonlySet<number>,
  maxSpendIndices: ReadonlySet<number>,
): TradeProblem[] {
  const problems: TradeProblem[] = [];
  const add = (field: string, message: string): void => {
    problems.push({ field, message });
  };
  const sides = (prefix: string, v: Partial<FleetTradeV1 | WalletTradeV1>): void => {
    for (const key of ['buySlippageBps', 'sellSlippageBps'] as const) {
      if (key in v && !isSlippageSetting(v[key])) add(`${prefix}.${key}`, MESSAGES.slippage);
    }
    for (const key of ['buyPriorityFeeLamports', 'sellPriorityFeeLamports'] as const) {
      if (key in v && !isPriorityFeeSetting(v[key])) add(`${prefix}.${key}`, MESSAGES.priorityFee);
    }
    if ('sellPercent' in v && !isTradePercent(v.sellPercent)) {
      add(`${prefix}.sellPercent`, MESSAGES.percent);
    }
  };

  const f = trade.fleet;
  sides('fleet', f);
  const amount = f.buyAmount;
  if (amount !== null) {
    // Read as unknown: a value from a file or a request may be anything.
    const a = (typeof amount === 'object' ? amount : {}) as Record<string, unknown>;
    if (a.kind === 'percent') {
      if (!isTradePercent(a.percent)) add('fleet.buyAmount', MESSAGES.percent);
    } else if (a.kind !== 'lamports' || typeof a.lamports !== 'bigint') {
      add('fleet.buyAmount', MESSAGES.amountKind);
    } else if (a.lamports <= 0n) {
      add('fleet.buyAmount', MESSAGES.lamports);
    }
  }

  const seen = new Set<number>();
  for (const w of trade.wallets) {
    const prefix = `wallet.${String(w.index)}`;
    if (!walletIndices.has(w.index)) add(prefix, MESSAGES.unknownWallet);
    if (seen.has(w.index)) add(prefix, MESSAGES.duplicate);
    seen.add(w.index);
    sides(prefix, w);
    if (w.buyPercent !== undefined) {
      if (!isTradePercent(w.buyPercent)) add(`${prefix}.buyPercent`, MESSAGES.percent);
      if (maxSpendIndices.has(w.index)) add(`${prefix}.buyPercent`, MESSAGES.twoAmounts);
    }
  }
  return problems;
}
