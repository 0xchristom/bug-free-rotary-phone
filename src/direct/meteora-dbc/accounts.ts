/**
 * Meteora DBC account decoders (BUNNDLY-47, D-053). Layouts are from the program IDL
 * `dynamic_bonding_curve` 0.2.1 shipped in `@meteora-ag/dynamic-bonding-curve-sdk` 1.5.13
 * (MIT): both accounts are `bytemuck` (C layout, little-endian) after the 8-byte Anchor
 * discriminator. Offsets below are from the start of the account data, discriminator
 * included.
 */
import type { CurvePoint, QuoteConfig, QuotePool } from './math.ts';

export const DBC_PROGRAM_ADDRESS = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';

/** IDL `accounts[].discriminator`. */
export const VIRTUAL_POOL_DISCRIMINATOR = [213, 224, 5, 209, 98, 69, 119, 92] as const;
export const POOL_CONFIG_DISCRIMINATOR = [26, 108, 14, 123, 116, 230, 129, 43] as const;

/** 8 + size of `VirtualPool` (416) and `PoolConfig` (1040) in the IDL. */
export const VIRTUAL_POOL_SIZE = 8 + 416;
export const POOL_CONFIG_SIZE = 8 + 1040;
/** `pool_state.base_mint` offset, used by the `getProgramAccounts` filter. */
export const POOL_BASE_MINT_OFFSET = 8 + 128;

const CURVE_POINTS = 20;

export const ActivationType = { Slot: 0, Timestamp: 1 } as const;
export const TokenType = { SplToken: 0, Token2022: 1 } as const;

export interface VirtualPool extends QuotePool {
  readonly config: string;
  readonly creator: string;
  readonly baseMint: string;
  readonly baseVault: string;
  readonly quoteVault: string;
  readonly baseReserve: bigint;
  readonly isMigrated: boolean;
  readonly migrationProgress: number;
}

export interface PoolConfig extends QuoteConfig {
  readonly quoteMint: string;
  readonly activationType: number;
  readonly tokenDecimal: number;
  readonly tokenType: number;
  readonly sqrtStartPrice: bigint;
}

export class DbcAccountError extends Error {
  override readonly name = 'DbcAccountError';
}

function reader(data: Uint8Array, encode: (bytes: Uint8Array) => string) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u64 = (at: number): bigint => view.getBigUint64(at, true);
  return {
    u8: (at: number): number => view.getUint8(at),
    u16: (at: number): number => view.getUint16(at, true),
    u32: (at: number): number => view.getUint32(at, true),
    u64,
    u128: (at: number): bigint => u64(at) | (u64(at + 8) << 64n),
    key: (at: number): string => encode(data.subarray(at, at + 32)),
  };
}

function checkHeader(
  data: Uint8Array,
  discriminator: readonly number[],
  size: number,
  name: string,
): void {
  if (data.length < size) throw new DbcAccountError(`${name}: account too short`);
  for (let i = 0; i < 8; i++) {
    if (data[i] !== discriminator[i]) throw new DbcAccountError(`${name}: wrong discriminator`);
  }
}

/** `encode` turns 32 bytes into a base58 address (kit's address decoder in production). */
export function decodeVirtualPool(
  data: Uint8Array,
  encode: (bytes: Uint8Array) => string,
): VirtualPool {
  checkHeader(data, VIRTUAL_POOL_DISCRIMINATOR, VIRTUAL_POOL_SIZE, 'VirtualPool');
  const r = reader(data, encode);
  const o = 8;
  return {
    // volatility_tracker: last_update_timestamp u64, padding [u8;8], sqrt_price_reference,
    // volatility_accumulator, volatility_reference (u128 each)
    volatilityAccumulator: r.u128(o + 32),
    config: r.key(o + 64),
    creator: r.key(o + 96),
    baseMint: r.key(o + 128),
    baseVault: r.key(o + 160),
    quoteVault: r.key(o + 192),
    baseReserve: r.u64(o + 224),
    quoteReserve: r.u64(o + 232),
    sqrtPrice: r.u128(o + 272),
    activationPoint: r.u64(o + 288),
    isMigrated: r.u8(o + 297) !== 0,
    migrationProgress: r.u8(o + 300),
  };
}

export function decodePoolConfig(
  data: Uint8Array,
  encode: (bytes: Uint8Array) => string,
): PoolConfig {
  checkHeader(data, POOL_CONFIG_DISCRIMINATOR, POOL_CONFIG_SIZE, 'PoolConfig');
  const r = reader(data, encode);
  const o = 8;
  const curve: CurvePoint[] = [];
  for (let i = 0; i < CURVE_POINTS; i++) {
    const at = o + 400 + i * 32;
    curve.push({ sqrtPrice: r.u128(at), liquidity: r.u128(at + 16) });
  }
  return {
    quoteMint: r.key(o),
    poolFees: {
      // base_fee: cliff_fee_numerator u64, second_factor u64, third_factor u64,
      // first_factor u16, base_fee_mode u8
      baseFee: {
        cliffFeeNumerator: r.u64(o + 96),
        secondFactor: r.u64(o + 104),
        thirdFactor: r.u64(o + 112),
        firstFactor: r.u16(o + 120),
        baseFeeMode: r.u8(o + 122),
      },
      // dynamic_fee: initialized u8 @128, max_volatility_accumulator u32 @136,
      // variable_fee_control u32 @140, bin_step u16 @144
      dynamicFee: {
        initialized: r.u8(o + 128),
        variableFeeControl: r.u32(o + 140),
        binStep: r.u16(o + 144),
      },
    },
    collectFeeMode: r.u8(o + 224),
    activationType: r.u8(o + 226),
    tokenDecimal: r.u8(o + 227),
    tokenType: r.u8(o + 229),
    migrationQuoteThreshold: r.u64(o + 256),
    migrationSqrtPrice: r.u128(o + 272),
    sqrtStartPrice: r.u128(o + 384),
    curve,
  };
}
