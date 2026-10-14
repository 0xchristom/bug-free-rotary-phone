/**
 * Trade parameters per wallet with fleet defaults (BUNNDLY-58): which value a wallet
 * trades with, and which values the form and the worker refuse.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRADE_SETTINGS,
  validateTradeSettings,
  walletTrade,
  type TradeSettingsV1,
} from '../../src/core/trade.ts';

const WALLETS = new Set([0, 1, 2]);
const NONE = new Set<number>();

function trade(over: Partial<TradeSettingsV1['fleet']>, wallets: TradeSettingsV1['wallets'] = []) {
  return { fleet: { ...DEFAULT_TRADE_SETTINGS.fleet, ...over }, wallets };
}

describe('walletTrade: own value, else the fleet default', () => {
  it('a file from before the change: no buy amount unless maxSpend, sell 100 %, Auto', () => {
    expect(walletTrade(DEFAULT_TRADE_SETTINGS, 0, undefined)).toEqual({
      buyAmount: null,
      sellPercent: 100,
      buySlippageBps: null,
      sellSlippageBps: null,
      buyPriorityFeeLamports: null,
      sellPriorityFeeLamports: null,
    });
    expect(walletTrade(DEFAULT_TRADE_SETTINGS, 0, 25_000_000n).buyAmount).toEqual({
      kind: 'lamports',
      lamports: 25_000_000n,
    });
  });

  it('a change of the fleet default reaches wallets without their own value only', () => {
    const t = trade({ buySlippageBps: 300, sellPercent: 50 }, [
      { index: 1, buySlippageBps: 150 },
      { index: 2, buySlippageBps: null, sellPercent: 25 },
    ]);
    expect(walletTrade(t, 0, undefined)).toMatchObject({ buySlippageBps: 300, sellPercent: 50 });
    expect(walletTrade(t, 1, undefined)).toMatchObject({ buySlippageBps: 150, sellPercent: 50 });
    // an own null is "Auto", not "take the default"
    expect(walletTrade(t, 2, undefined)).toMatchObject({ buySlippageBps: null, sellPercent: 25 });
  });

  it('the two sides never mix', () => {
    const t = trade({}, [
      { index: 0, buySlippageBps: 250, sellSlippageBps: 1000, buyPriorityFeeLamports: 5n },
    ]);
    expect(walletTrade(t, 0, undefined)).toMatchObject({
      buySlippageBps: 250,
      sellSlippageBps: 1000,
      buyPriorityFeeLamports: 5n,
      sellPriorityFeeLamports: null,
    });
  });

  it('buy amount: own SOL amount, else own percent, else the fleet default', () => {
    const t = trade({ buyAmount: { kind: 'percent', percent: 10 } }, [
      { index: 1, buyPercent: 40 },
    ]);
    expect(walletTrade(t, 0, 7n).buyAmount).toEqual({ kind: 'lamports', lamports: 7n });
    expect(walletTrade(t, 1, undefined).buyAmount).toEqual({ kind: 'percent', percent: 40 });
    expect(walletTrade(t, 2, undefined).buyAmount).toEqual({ kind: 'percent', percent: 10 });
  });
});

describe('validateTradeSettings', () => {
  const fields = (t: TradeSettingsV1, maxSpend: ReadonlySet<number> = NONE) =>
    validateTradeSettings(t, WALLETS, maxSpend).map((p) => p.field);

  it('the defaults and the edges of every range are valid', () => {
    expect(fields(DEFAULT_TRADE_SETTINGS)).toEqual([]);
    const edges = trade(
      {
        buyAmount: { kind: 'percent', percent: 100 },
        sellPercent: 1,
        buySlippageBps: 10, // 0.1 %
        sellSlippageBps: 10_000, // 100 %
        buyPriorityFeeLamports: 100_000_000n, // 0.1 SOL
        sellPriorityFeeLamports: 1n,
      },
      [{ index: 0, buyPercent: 1, sellPercent: 100 }],
    );
    expect(fields(edges)).toEqual([]);
  });

  it('a priority fee above 0.1 SOL and slippage outside 0.1–100 % are refused', () => {
    const t = trade({ buyPriorityFeeLamports: 100_000_001n, sellSlippageBps: 9 }, [
      { index: 1, buySlippageBps: 10_001, sellPriorityFeeLamports: 0n },
      { index: 2, buySlippageBps: 2.5 },
    ]);
    expect(fields(t)).toEqual([
      'fleet.sellSlippageBps',
      'fleet.buyPriorityFeeLamports',
      'wallet.1.buySlippageBps',
      'wallet.1.sellPriorityFeeLamports',
      'wallet.2.buySlippageBps',
    ]);
  });

  it('percents are whole numbers from 1 to 100; a default SOL amount is above 0', () => {
    expect(fields(trade({ sellPercent: 0 }))).toEqual(['fleet.sellPercent']);
    expect(fields(trade({ buyAmount: { kind: 'percent', percent: 101 } }))).toEqual([
      'fleet.buyAmount',
    ]);
    expect(fields(trade({ buyAmount: { kind: 'lamports', lamports: 0n } }))).toEqual([
      'fleet.buyAmount',
    ]);
    expect(fields(trade({}, [{ index: 0, buyPercent: 12.5, sellPercent: 101 }]))).toEqual([
      'wallet.0.sellPercent',
      'wallet.0.buyPercent',
    ]);
  });

  it('a wallet with a SOL amount cannot also have a percent; unknown and repeated wallets', () => {
    expect(fields(trade({}, [{ index: 1, buyPercent: 20 }]), new Set([1]))).toEqual([
      'wallet.1.buyPercent',
    ]);
    expect(fields(trade({}, [{ index: 7 }, { index: 0 }, { index: 0 }]))).toEqual([
      'wallet.7',
      'wallet.0',
    ]);
  });

  it('messages never repeat the entered value', () => {
    const t = trade({ buyPriorityFeeLamports: 123_456_789n }, [
      { index: 0, buySlippageBps: 77_777 },
    ]);
    for (const p of validateTradeSettings(t, WALLETS, NONE)) {
      expect(p.message).not.toMatch(/123456789|77777|77 777/u);
    }
  });
});
