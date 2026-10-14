/**
 * Trade parameters in the encrypted part of the fleet file (BUNNDLY-58): a file from
 * before opens with the defaults and is written without them; values out of range are
 * reset like the global settings (D-019); the shape stays strict.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createKeystore,
  parseSecrets,
  secretsToJson,
  type KeystoreSecretsV1,
} from '../../../src/core/index.ts';
import { DEFAULT_TRADE_SETTINGS, type TradeSettingsV1 } from '../../../src/core/trade.ts';

let secrets: KeystoreSecretsV1;

beforeAll(async () => {
  secrets = (
    await createKeystore({ fleetName: 'Handel', walletCount: 3, password: 'x'.repeat(12) })
  ).secrets;
});

const json = (): Record<string, unknown> =>
  JSON.parse(secretsToJson(secrets)) as Record<string, unknown>;

function withTrade(trade: unknown, maxSpend: unknown[] = []): Record<string, unknown> {
  const raw = json();
  raw.settings = { ...(raw.settings as object), maxSpend, trade };
  return raw;
}

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
};

describe('trade parameters in the fleet file', () => {
  it('a file from before has no trade part, opens with the defaults and is written without it', () => {
    const raw = json();
    expect(raw.settings).not.toHaveProperty('trade');
    const read = parseSecrets(raw);
    expect(read.settings.trade).toEqual(DEFAULT_TRADE_SETTINGS);
    expect(read.settings.resetTradeFields).toBeUndefined();
    expect(JSON.parse(secretsToJson(read))).toEqual(raw);
  });

  it('round-trips every kind of value; fees as lamport strings, null as Auto', () => {
    const trade: TradeSettingsV1 = {
      fleet: {
        buyAmount: { kind: 'percent', percent: 20 },
        sellPercent: 50,
        buySlippageBps: 250,
        sellSlippageBps: null,
        buyPriorityFeeLamports: 100_000_000n,
        sellPriorityFeeLamports: null,
      },
      wallets: [
        { index: 0, buyPercent: 5, sellSlippageBps: 1000 },
        { index: 2, buyPriorityFeeLamports: null, sellPriorityFeeLamports: 12_345n },
      ],
    };
    const full = { ...secrets, settings: { ...secrets.settings, trade } };
    const text = secretsToJson(full);
    expect(text).toContain('"buyPriorityFeeLamports":"100000000"');
    expect(text).toContain('"sellPriorityFeeLamports":"12345"');
    expect(text).toContain('"buyAmount":{"percent":20}');
    expect(parseSecrets(JSON.parse(text)).settings.trade).toEqual(trade);

    const sol: TradeSettingsV1 = {
      ...trade,
      fleet: { ...trade.fleet, buyAmount: { kind: 'lamports', lamports: 7n } },
    };
    const solText = secretsToJson({ ...secrets, settings: { ...secrets.settings, trade: sol } });
    expect(solText).toContain('"buyAmount":{"lamports":"7"}');
    expect(parseSecrets(JSON.parse(solText)).settings.trade).toEqual(sol);
  });

  it('values out of range: the fleet field takes the default, the wallet field is dropped', () => {
    const raw = withTrade({
      fleet: { buySlippageBps: 5, sellPercent: 0, buyPriorityFeeLamports: '100000001' },
      wallets: [{ index: 1, buySlippageBps: 300, sellSlippageBps: 10_001 }],
    });
    const { trade, resetTradeFields } = parseSecrets(raw).settings;
    expect(trade.fleet).toEqual(DEFAULT_TRADE_SETTINGS.fleet);
    expect(trade.wallets).toEqual([{ index: 1, buySlippageBps: 300 }]);
    expect([...(resetTradeFields ?? [])].sort()).toEqual([
      'fleet.buyPriorityFeeLamports',
      'fleet.buySlippageBps',
      'fleet.sellPercent',
      'wallet.1.sellSlippageBps',
    ]);
  });

  it('a value of the wrong type is reset too; a percent next to a SOL amount is dropped', () => {
    const raw = withTrade(
      {
        fleet: { buyAmount: { percent: '5' }, sellPriorityFeeLamports: 5 },
        wallets: [{ index: 0, buyPercent: 30 }],
      },
      [{ index: 0, lamports: '10000000' }],
    );
    const { trade, resetTradeFields } = parseSecrets(raw).settings;
    expect(trade.fleet.buyAmount).toBeNull();
    expect(trade.fleet.sellPriorityFeeLamports).toBeNull();
    expect(trade.wallets).toEqual([{ index: 0 }]);
    expect([...(resetTradeFields ?? [])].sort()).toEqual([
      'fleet.buyAmount',
      'fleet.sellPriorityFeeLamports',
      'wallet.0.buyPercent',
    ]);
  });

  it.each([
    ['an unknown key', { fleet: { tip: 1 } }],
    ['an unknown wallet key', { wallets: [{ index: 0, antiMev: true }] }],
    ['a wallet not in the fleet', { wallets: [{ index: 9 }] }],
    ['a wallet twice', { wallets: [{ index: 0 }, { index: 0 }] }],
    ['wallets not a list', { wallets: {} }],
    ['an unknown part', { fleet: {}, extra: {} }],
  ])('the shape stays strict: %s is an invalid file', (_name, trade) => {
    expect(codeOf(() => parseSecrets(withTrade(trade)))).toBe('KEYSTORE_INVALID_FORMAT');
  });
});
