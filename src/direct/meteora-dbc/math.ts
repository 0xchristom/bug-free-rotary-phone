/**
 * Meteora DBC buy-side quote math (BUNNDLY-47, D-053): a bigint port of the exact-in path
 * of `@meteora-ag/dynamic-bonding-curve-sdk` 1.5.13 (MIT), files `src/math/swapQuote.ts`
 * (`swapQuoteExactIn`, `getSwapResultFromExactInput`, `calculateQuoteToBaseFromAmountIn`),
 * `curve.ts`, `feeMath.ts`, `utilsMath.ts`, `safeMath.ts` (`pow`) and `poolFees/*`.
 * Only the quote → base direction (a buy) is ported; names follow the SDK so the two can
 * be read side by side. Commit of the SDK: see D-053.
 *
 * Original copyright and licence of the ported code:
 *
 * MIT License
 *
 * Copyright (c) 2026 Meteora
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

export const RESOLUTION = 64n;
export const FEE_DENOMINATOR = 1_000_000_000n;
export const MAX_BASIS_POINT = 10_000n;
export const MAX_FEE_NUMERATOR = 990_000_000n;
export const PROTOCOL_FEE_PERCENT = 20n;
export const HOST_FEE_PERCENT = 20n;
const U16_MAX = 65_535n;
const U128_MAX = (1n << 128n) - 1n;
const DYNAMIC_FEE_SCALING_FACTOR = 100_000_000_000n;
const DYNAMIC_FEE_ROUNDING_OFFSET = 99_999_999_999n;

/** `BaseFeeMode` from the SDK types. */
export const BaseFeeMode = {
  FeeSchedulerLinear: 0,
  FeeSchedulerExponential: 1,
  RateLimiter: 2,
} as const;

/** `CollectFeeMode` from the SDK types. */
export const CollectFeeMode = { QuoteToken: 0, OutputToken: 1 } as const;

export interface BaseFeeConfig {
  readonly cliffFeeNumerator: bigint;
  /** feeScheduler: numberOfPeriod; rateLimiter: feeIncrementBps. */
  readonly firstFactor: number;
  /** feeScheduler: periodFrequency; rateLimiter: maxLimiterDuration. */
  readonly secondFactor: bigint;
  /** feeScheduler: reductionFactor; rateLimiter: referenceAmount. */
  readonly thirdFactor: bigint;
  readonly baseFeeMode: number;
}

export interface DynamicFeeConfig {
  readonly initialized: number;
  readonly binStep: number;
  readonly variableFeeControl: number;
}

export interface PoolFeesConfig {
  readonly baseFee: BaseFeeConfig;
  readonly dynamicFee: DynamicFeeConfig;
}

export interface CurvePoint {
  readonly sqrtPrice: bigint;
  readonly liquidity: bigint;
}

/** The config fields the buy quote reads. */
export interface QuoteConfig {
  readonly poolFees: PoolFeesConfig;
  readonly collectFeeMode: number;
  readonly migrationQuoteThreshold: bigint;
  readonly migrationSqrtPrice: bigint;
  readonly curve: readonly CurvePoint[];
}

/** The pool fields the buy quote reads. */
export interface QuotePool {
  readonly sqrtPrice: bigint;
  readonly quoteReserve: bigint;
  readonly activationPoint: bigint;
  readonly volatilityAccumulator: bigint;
}

export class DbcMathError extends Error {
  override readonly name = 'DbcMathError';
}

function sub(a: bigint, b: bigint): bigint {
  if (b > a) throw new DbcMathError('SafeMath: subtraction overflow');
  return a - b;
}

function div(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new DbcMathError('SafeMath: division by zero');
  return a / b;
}

/** utilsMath.ts `mulDiv`. */
export function mulDiv(x: bigint, y: bigint, denominator: bigint, roundUp: boolean): bigint {
  if (denominator === 0n) throw new DbcMathError('MulDiv: division by zero');
  if (denominator === 1n || x === 0n || y === 0n) return x * y;
  const prod = x * y;
  return roundUp ? (prod + denominator - 1n) / denominator : prod / denominator;
}

/** safeMath.ts `pow` (Q64 scaling, non-negative exponent only: the buy path never uses a negative one). */
function powQ64(base: bigint, exponent: bigint): bigint {
  const ONE = 1n << RESOLUTION;
  if (exponent === 0n) return ONE;
  if (base === 0n) return 0n;
  if (base === ONE) return ONE;
  let result = ONE;
  let currentBase = base;
  let exp = exponent;
  while (exp !== 0n) {
    if ((exp & 1n) === 1n) result = (result * currentBase) / ONE;
    currentBase = (currentBase * currentBase) / ONE;
    exp >>= 1n;
  }
  return result;
}

/** feeMath.ts `toNumerator`. */
function toNumerator(bps: bigint): bigint {
  return mulDiv(bps, FEE_DENOMINATOR, MAX_BASIS_POINT, false);
}

// ---- poolFees/feeScheduler.ts ----

function getBaseFeeNumeratorByPeriod(
  cliffFeeNumerator: bigint,
  numberOfPeriod: number,
  period: bigint,
  reductionFactor: bigint,
  mode: number,
): bigint {
  const periodValue = period < BigInt(numberOfPeriod) ? period : BigInt(numberOfPeriod);
  if (periodValue > U16_MAX) throw new DbcMathError('Math overflow');
  if (mode === BaseFeeMode.FeeSchedulerLinear) {
    return sub(cliffFeeNumerator, periodValue * reductionFactor);
  }
  if (mode === BaseFeeMode.FeeSchedulerExponential) {
    if (periodValue === 0n) return cliffFeeNumerator;
    const ONE_Q64 = 1n << RESOLUTION;
    const bps = (reductionFactor << RESOLUTION) / MAX_BASIS_POINT;
    const base = sub(ONE_Q64, bps);
    return (cliffFeeNumerator * powQ64(base, periodValue)) / ONE_Q64;
  }
  throw new DbcMathError('Invalid fee scheduler mode');
}

function getFeeSchedulerNumerator(
  fee: BaseFeeConfig,
  currentPoint: bigint,
  activationPoint: bigint,
): bigint {
  const periodFrequency = fee.secondFactor;
  if (periodFrequency === 0n) return fee.cliffFeeNumerator;
  const period = (currentPoint - activationPoint) / periodFrequency;
  return getBaseFeeNumeratorByPeriod(
    fee.cliffFeeNumerator,
    fee.firstFactor,
    period,
    fee.thirdFactor,
    fee.baseFeeMode,
  );
}

// ---- poolFees/rateLimiter.ts (buy side: quote → base) ----

function getMaxIndex(cliffFeeNumerator: bigint, feeIncrementBps: bigint): bigint {
  if (cliffFeeNumerator > MAX_FEE_NUMERATOR) {
    throw new DbcMathError('Cliff fee numerator exceeds maximum fee numerator');
  }
  const feeIncrementNumerator = toNumerator(feeIncrementBps);
  if (feeIncrementNumerator === 0n) {
    throw new DbcMathError('Fee increment numerator cannot be zero');
  }
  return (MAX_FEE_NUMERATOR - cliffFeeNumerator) / feeIncrementNumerator;
}

function getRateLimiterNumeratorFromIncludedAmount(
  c: bigint,
  referenceAmount: bigint,
  feeIncrementBps: bigint,
  includedFeeAmount: bigint,
): bigint {
  if (includedFeeAmount <= referenceAmount) return c;
  const diff = includedFeeAmount - referenceAmount;
  const a = diff / referenceAmount;
  const b = diff % referenceAmount;
  const maxIndex = getMaxIndex(c, feeIncrementBps);
  const i = toNumerator(feeIncrementBps);
  const x0 = referenceAmount;
  let tradingFeeNumerator: bigint;
  if (a < maxIndex) {
    const numerator1 = c + c * a + (i * a * (a + 1n)) / 2n;
    const numerator2 = c + i * (a + 1n);
    tradingFeeNumerator = x0 * numerator1 + b * numerator2;
  } else {
    const numerator1 = c + c * maxIndex + (i * maxIndex * (maxIndex + 1n)) / 2n;
    const leftAmount = (a - maxIndex) * x0 + b;
    tradingFeeNumerator = x0 * numerator1 + leftAmount * MAX_FEE_NUMERATOR;
  }
  const tradingFee = (tradingFeeNumerator + FEE_DENOMINATOR - 1n) / FEE_DENOMINATOR;
  return mulDiv(tradingFee, FEE_DENOMINATOR, includedFeeAmount, true);
}

function getRateLimiterNumerator(
  fee: BaseFeeConfig,
  currentPoint: bigint,
  activationPoint: bigint,
  includedFeeAmount: bigint,
): bigint {
  const feeIncrementBps = BigInt(fee.firstFactor);
  const maxLimiterDuration = fee.secondFactor;
  const referenceAmount = fee.thirdFactor;
  const isZero = referenceAmount === 0n && maxLimiterDuration === 0n && feeIncrementBps === 0n;
  // isRateLimiterApplied: a buy is quote → base, so only the point window is checked.
  if (isZero || currentPoint > activationPoint + maxLimiterDuration) {
    return fee.cliffFeeNumerator;
  }
  return getRateLimiterNumeratorFromIncludedAmount(
    fee.cliffFeeNumerator,
    referenceAmount,
    feeIncrementBps,
    includedFeeAmount,
  );
}

// ---- feeMath.ts ----

/** poolFees/baseFee.ts `getBaseFeeNumeratorFromIncludedFeeAmount`, buy side. */
export function getBaseFeeNumerator(
  fee: BaseFeeConfig,
  currentPoint: bigint,
  activationPoint: bigint,
  includedFeeAmount: bigint,
): bigint {
  switch (fee.baseFeeMode) {
    case BaseFeeMode.FeeSchedulerLinear:
    case BaseFeeMode.FeeSchedulerExponential:
      return getFeeSchedulerNumerator(fee, currentPoint, activationPoint);
    case BaseFeeMode.RateLimiter:
      return getRateLimiterNumerator(fee, currentPoint, activationPoint, includedFeeAmount);
    default:
      throw new DbcMathError('Invalid base fee mode');
  }
}

/** poolFees/dynamicFee.ts `getVariableFeeNumerator`. */
export function getVariableFeeNumerator(
  dynamicFee: DynamicFeeConfig,
  volatilityAccumulator: bigint,
): bigint {
  if (dynamicFee.initialized === 0) return 0n;
  const volatilityTimesBinStep = volatilityAccumulator * BigInt(dynamicFee.binStep);
  const vFee =
    volatilityTimesBinStep * volatilityTimesBinStep * BigInt(dynamicFee.variableFeeControl);
  return (vFee + DYNAMIC_FEE_ROUNDING_OFFSET) / DYNAMIC_FEE_SCALING_FACTOR;
}

/** `getTotalFeeNumeratorFromIncludedFeeAmount`, capped at MAX_FEE_NUMERATOR. */
export function getTotalFeeNumerator(
  poolFees: PoolFeesConfig,
  pool: QuotePool,
  currentPoint: bigint,
  includedFeeAmount: bigint,
): bigint {
  const total =
    getVariableFeeNumerator(poolFees.dynamicFee, pool.volatilityAccumulator) +
    getBaseFeeNumerator(poolFees.baseFee, currentPoint, pool.activationPoint, includedFeeAmount);
  return total > MAX_FEE_NUMERATOR ? MAX_FEE_NUMERATOR : total;
}

export interface FeeOnAmount {
  readonly amount: bigint;
  readonly tradingFee: bigint;
  readonly protocolFee: bigint;
  readonly referralFee: bigint;
}

/** feeMath.ts `getFeeOnAmount` (with `getExcludedFeeAmount`). */
export function getFeeOnAmount(
  tradeFeeNumerator: bigint,
  amount: bigint,
  hasReferral: boolean,
): FeeOnAmount {
  const tradingFee = mulDiv(amount, tradeFeeNumerator, FEE_DENOMINATOR, true);
  const amountAfterFee = sub(amount, tradingFee);
  const protocolFee = mulDiv(tradingFee, PROTOCOL_FEE_PERCENT, 100n, false);
  const referralFee = hasReferral ? mulDiv(protocolFee, HOST_FEE_PERCENT, 100n, false) : 0n;
  return {
    amount: amountAfterFee,
    tradingFee: sub(tradingFee, protocolFee),
    protocolFee: sub(protocolFee, referralFee),
    referralFee,
  };
}

// ---- curve.ts ----

/** L * (√P_upper - √P_lower) / (√P_upper * √P_lower). */
export function getDeltaAmountBaseUnsigned(
  lowerSqrtPrice: bigint,
  upperSqrtPrice: bigint,
  liquidity: bigint,
  roundUp: boolean,
): bigint {
  const denominator = lowerSqrtPrice * upperSqrtPrice;
  if (denominator === 0n) throw new DbcMathError('Denominator cannot be zero');
  return mulDiv(liquidity, sub(upperSqrtPrice, lowerSqrtPrice), denominator, roundUp);
}

/** L * (√P_upper - √P_lower) >> 128, rounded as asked. */
export function getDeltaAmountQuoteUnsigned(
  lowerSqrtPrice: bigint,
  upperSqrtPrice: bigint,
  liquidity: bigint,
  roundUp: boolean,
): bigint {
  const prod = liquidity * sub(upperSqrtPrice, lowerSqrtPrice);
  if (roundUp) {
    const denominator = 1n << (RESOLUTION * 2n);
    return (prod + denominator - 1n) / denominator;
  }
  return prod >> (RESOLUTION * 2n);
}

/** `getNextSqrtPriceFromInput` for quote in: √P' = √P + (Δy << 128) / L, rounded down. */
export function getNextSqrtPriceFromQuoteInput(
  sqrtPrice: bigint,
  liquidity: bigint,
  amountIn: bigint,
): bigint {
  if (sqrtPrice === 0n) throw new DbcMathError('sqrt_price must be greater than 0');
  if (liquidity === 0n) throw new DbcMathError('liquidity must be greater than 0');
  return sqrtPrice + div(amountIn << (RESOLUTION * 2n), liquidity);
}

export interface SwapAmount {
  readonly outputAmount: bigint;
  readonly nextSqrtPrice: bigint;
  readonly amountLeft: bigint;
}

/** swapQuote.ts `calculateQuoteToBaseFromAmountIn`. */
export function calculateQuoteToBaseFromAmountIn(
  curve: readonly CurvePoint[],
  currentSqrtPrice: bigint,
  amountIn: bigint,
  stopSqrtPrice: bigint,
): SwapAmount {
  if (amountIn === 0n) {
    return { outputAmount: 0n, nextSqrtPrice: currentSqrtPrice, amountLeft: 0n };
  }
  let totalOutputAmount = 0n;
  let current = currentSqrtPrice;
  let amountLeft = amountIn;
  for (const point of curve) {
    if (point.sqrtPrice === 0n || point.liquidity === 0n) break;
    const referenceSqrtPrice = stopSqrtPrice < point.sqrtPrice ? stopSqrtPrice : point.sqrtPrice;
    if (referenceSqrtPrice <= current) continue;
    const maxAmountIn = getDeltaAmountQuoteUnsigned(
      current,
      referenceSqrtPrice,
      point.liquidity,
      true,
    );
    if (amountLeft < maxAmountIn) {
      const nextSqrtPrice = getNextSqrtPriceFromQuoteInput(current, point.liquidity, amountLeft);
      totalOutputAmount += getDeltaAmountBaseUnsigned(
        current,
        nextSqrtPrice,
        point.liquidity,
        false,
      );
      current = nextSqrtPrice;
      amountLeft = 0n;
      break;
    }
    totalOutputAmount += getDeltaAmountBaseUnsigned(
      current,
      referenceSqrtPrice,
      point.liquidity,
      false,
    );
    current = referenceSqrtPrice;
    amountLeft = sub(amountLeft, maxAmountIn);
    if (referenceSqrtPrice === stopSqrtPrice) break;
  }
  return { outputAmount: totalOutputAmount, nextSqrtPrice: current, amountLeft };
}

export interface BuyQuote {
  /** Lamports in, fees included (`included_fee_input_amount`). */
  readonly includedFeeInputAmount: bigint;
  /** Lamports that moved the curve (`excluded_fee_input_amount`). */
  readonly excludedFeeInputAmount: bigint;
  /** Base token units the buyer receives. */
  readonly outputAmount: bigint;
  readonly nextSqrtPrice: bigint;
  readonly tradingFee: bigint;
  readonly protocolFee: bigint;
  readonly referralFee: bigint;
}

export type BuyQuoteResult =
  | { readonly kind: 'ok'; readonly quote: BuyQuote }
  /** quote reserve reached the migration threshold: the curve is complete. */
  | { readonly kind: 'completed' }
  /** the amount does not fit in the rest of the curve (SDK: "Insufficient Liquidity"). */
  | { readonly kind: 'insufficient-liquidity'; readonly amountLeft: bigint };

/**
 * swapQuote.ts `swapQuoteExactIn` for a buy (quote → base), without the first-swap
 * minimum fee (that applies only to the swap in the pool creation transaction).
 */
export function quoteBuyExactIn(
  pool: QuotePool,
  config: QuoteConfig,
  amountIn: bigint,
  currentPoint: bigint,
  hasReferral = false,
): BuyQuoteResult {
  if (pool.quoteReserve >= config.migrationQuoteThreshold) return { kind: 'completed' };
  if (amountIn <= 0n) throw new RangeError('amountIn must be positive');
  if (amountIn > (1n << 64n) - 1n) throw new RangeError('amountIn must fit in u64');
  if (config.migrationSqrtPrice > U128_MAX) throw new DbcMathError('migration price overflow');

  // getFeeMode: QuoteToken → fees on input; OutputToken → fees on the base output.
  const feesOnInput = config.collectFeeMode === CollectFeeMode.QuoteToken;
  const tradeFeeNumerator = getTotalFeeNumerator(config.poolFees, pool, currentPoint, amountIn);

  let fees: Omit<FeeOnAmount, 'amount'> = { tradingFee: 0n, protocolFee: 0n, referralFee: 0n };
  let actualAmountIn = amountIn;
  if (feesOnInput) {
    const fee = getFeeOnAmount(tradeFeeNumerator, amountIn, hasReferral);
    actualAmountIn = fee.amount;
    fees = fee;
  }
  const swap = calculateQuoteToBaseFromAmountIn(
    config.curve,
    pool.sqrtPrice,
    actualAmountIn,
    config.migrationSqrtPrice,
  );
  if (swap.amountLeft !== 0n) {
    return { kind: 'insufficient-liquidity', amountLeft: swap.amountLeft };
  }
  let outputAmount = swap.outputAmount;
  if (!feesOnInput) {
    const fee = getFeeOnAmount(tradeFeeNumerator, swap.outputAmount, hasReferral);
    outputAmount = fee.amount;
    fees = fee;
  }
  return {
    kind: 'ok',
    quote: {
      includedFeeInputAmount: amountIn,
      excludedFeeInputAmount: actualAmountIn,
      outputAmount,
      nextSqrtPrice: swap.nextSqrtPrice,
      tradingFee: fees.tradingFee,
      protocolFee: fees.protocolFee,
      referralFee: fees.referralFee,
    },
  };
}

/** `minimumAmountOut = out * (10000 - slippageBps) / 10000`, rounded down. */
export function minimumAmountOut(outputAmount: bigint, slippageBps: number): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > 10_000) {
    throw new RangeError('slippageBps must be an integer in 0..10000');
  }
  return (outputAmount * BigInt(10_000 - slippageBps)) / MAX_BASIS_POINT;
}
