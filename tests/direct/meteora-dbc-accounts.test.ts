/**
 * DBC account layouts (BUNNDLY-47): offsets written here by hand from the IDL type dump
 * (`dynamic_bonding_curve` 0.2.1, bytemuck/C layout, + 8-byte discriminator). Every field
 * gets a different value, so a decoder reading a neighbour's offset fails.
 */
import { describe, expect, it } from 'vitest';
import {
  DbcAccountError,
  POOL_CONFIG_DISCRIMINATOR,
  VIRTUAL_POOL_DISCRIMINATOR,
  decodePoolConfig,
  decodeVirtualPool,
} from '../../src/direct/meteora-dbc/accounts.ts';

/** Fake address: "k<offset>" so the test sees which 32 bytes were read. */
const encode = (b: Uint8Array) => `k${String(b[0] ?? 0)}-${String(b[31] ?? 0)}`;

function buffer(size: number, discriminator: readonly number[]) {
  const data = new Uint8Array(size);
  data.set(discriminator, 0);
  const view = new DataView(data.buffer);
  return {
    data,
    u8: (at: number, v: number) => {
      view.setUint8(8 + at, v);
    },
    u16: (at: number, v: number) => {
      view.setUint16(8 + at, v, true);
    },
    u32: (at: number, v: number) => {
      view.setUint32(8 + at, v, true);
    },
    u64: (at: number, v: bigint) => {
      view.setBigUint64(8 + at, v, true);
    },
    u128: (at: number, v: bigint) => {
      view.setBigUint64(8 + at, v & ((1n << 64n) - 1n), true);
      view.setBigUint64(8 + at + 8, v >> 64n, true);
    },
    key: (at: number, tag: number) => {
      data[8 + at] = tag;
      data[8 + at + 31] = tag;
    },
  };
}

describe('VirtualPool', () => {
  it('reads every field from its IDL offset', () => {
    const b = buffer(8 + 416, VIRTUAL_POOL_DISCRIMINATOR);
    b.u128(16, 111n); // volatility_tracker.sqrt_price_reference
    b.u128(32, (7n << 64n) + 5n); // volatility_tracker.volatility_accumulator
    b.u128(48, 333n); // volatility_tracker.volatility_reference
    b.key(64, 1); // config
    b.key(96, 2); // creator
    b.key(128, 3); // base_mint
    b.key(160, 4); // base_vault
    b.key(192, 5); // quote_vault
    b.u64(224, 1001n); // base_reserve
    b.u64(232, 1002n); // quote_reserve
    b.u128(272, (9n << 64n) + 1n); // sqrt_price
    b.u64(288, 1003n); // activation_point
    b.u8(296, 4); // pool_type
    b.u8(297, 1); // is_migrated
    b.u8(300, 3); // migration_progress
    expect(decodeVirtualPool(b.data, encode)).toEqual({
      volatilityAccumulator: (7n << 64n) + 5n,
      config: 'k1-1',
      creator: 'k2-2',
      baseMint: 'k3-3',
      baseVault: 'k4-4',
      quoteVault: 'k5-5',
      baseReserve: 1001n,
      quoteReserve: 1002n,
      sqrtPrice: (9n << 64n) + 1n,
      activationPoint: 1003n,
      isMigrated: true,
      migrationProgress: 3,
    });
  });

  it('refuses a wrong discriminator and a short account', () => {
    const b = buffer(8 + 416, POOL_CONFIG_DISCRIMINATOR);
    expect(() => decodeVirtualPool(b.data, encode)).toThrow(DbcAccountError);
    const short = buffer(8 + 415, VIRTUAL_POOL_DISCRIMINATOR);
    expect(() => decodeVirtualPool(short.data, encode)).toThrow(DbcAccountError);
  });
});

describe('PoolConfig', () => {
  it('reads every field from its IDL offset', () => {
    const b = buffer(8 + 1040, POOL_CONFIG_DISCRIMINATOR);
    b.key(0, 9); // quote_mint
    b.u64(96, 2001n); // base_fee.cliff_fee_numerator
    b.u64(104, 2002n); // base_fee.second_factor
    b.u64(112, 2003n); // base_fee.third_factor
    b.u16(120, 2004); // base_fee.first_factor
    b.u8(122, 2); // base_fee.base_fee_mode
    b.u8(128, 1); // dynamic_fee.initialized
    b.u32(136, 3001); // dynamic_fee.max_volatility_accumulator
    b.u32(140, 3002); // dynamic_fee.variable_fee_control
    b.u16(144, 3003); // dynamic_fee.bin_step
    b.u16(146, 3004); // dynamic_fee.filter_period
    b.u8(224, 1); // collect_fee_mode
    b.u8(225, 7); // migration_option
    b.u8(226, 1); // activation_type
    b.u8(227, 9); // token_decimal
    b.u8(228, 5); // version
    b.u8(229, 1); // token_type
    b.u8(230, 6); // quote_token_flag
    b.u64(248, 4000n); // swap_base_amount
    b.u64(256, 4001n); // migration_quote_threshold
    b.u64(264, 4002n); // migration_base_threshold
    b.u128(272, (3n << 64n) + 4003n); // migration_sqrt_price
    b.u128(384, (2n << 64n) + 4004n); // sqrt_start_price
    b.u128(400, 5001n); // curve[0].sqrt_price
    b.u128(416, 5002n); // curve[0].liquidity
    b.u128(400 + 19 * 32, 5039n); // curve[19].sqrt_price
    b.u128(416 + 19 * 32, 5040n); // curve[19].liquidity
    const config = decodePoolConfig(b.data, encode);
    expect(config).toMatchObject({
      quoteMint: 'k9-9',
      poolFees: {
        baseFee: {
          cliffFeeNumerator: 2001n,
          secondFactor: 2002n,
          thirdFactor: 2003n,
          firstFactor: 2004,
          baseFeeMode: 2,
        },
        dynamicFee: { initialized: 1, variableFeeControl: 3002, binStep: 3003 },
      },
      collectFeeMode: 1,
      activationType: 1,
      tokenDecimal: 9,
      tokenType: 1,
      migrationQuoteThreshold: 4001n,
      migrationSqrtPrice: (3n << 64n) + 4003n,
      sqrtStartPrice: (2n << 64n) + 4004n,
    });
    expect(config.curve).toHaveLength(20);
    expect(config.curve[0]).toEqual({ sqrtPrice: 5001n, liquidity: 5002n });
    expect(config.curve[19]).toEqual({ sqrtPrice: 5039n, liquidity: 5040n });
  });

  it('refuses a wrong discriminator', () => {
    const b = buffer(8 + 1040, VIRTUAL_POOL_DISCRIMINATOR);
    expect(() => decodePoolConfig(b.data, encode)).toThrow(DbcAccountError);
  });
});
