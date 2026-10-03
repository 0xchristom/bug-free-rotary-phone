/**
 * Launchpad programs, instruction discriminators, account positions and event layouts
 * (BUNNDLY-33, D-037). Everything here comes from the official IDLs (SPEC 0.1):
 *
 * - pump.fun: https://raw.githubusercontent.com/pump-fun/pump-public-docs/main/idl/pump.json
 * - Meteora DBC: https://raw.githubusercontent.com/MeteoraAg/dynamic-bonding-curve-sdk/main/packages/dynamic-bonding-curve/src/idl/dynamic-bonding-curve/idl.json
 * - Raydium LaunchLab: https://raw.githubusercontent.com/raydium-io/raydium-idl/master/raydium_launchpad/raydium_launchpad.json
 * - SPL Token / Token-2022 `InitializeMint` (0) and `InitializeMint2` (20):
 *   https://github.com/solana-program/token/blob/main/program/src/instruction.rs
 */

/** Moonshot has no confirmed official IDL: its launches come through `initialize-mint`. */
export type DetectionSource = 'pump.fun' | 'raydium-launchlab' | 'meteora-dbc' | 'initialize-mint';

export const PUMP_FUN_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const METEORA_DBC_PROGRAM = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN';
export const RAYDIUM_LAUNCHLAB_PROGRAM = 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/** An instruction that creates a mint, and where the mint is in its account list. */
export interface MintInstruction {
  readonly source: DetectionSource;
  readonly program: string;
  readonly name: string;
  readonly discriminator: readonly number[];
  /** Index of the new mint in the instruction's accounts. */
  readonly mintAccount: number;
}

export const MINT_INSTRUCTIONS: readonly MintInstruction[] = [
  // pump.fun: accounts 0 `mint` (signer), 7 / 5 `user` (signer)
  {
    source: 'pump.fun',
    program: PUMP_FUN_PROGRAM,
    name: 'create',
    discriminator: [24, 30, 200, 40, 5, 28, 7, 119],
    mintAccount: 0,
  },
  {
    source: 'pump.fun',
    program: PUMP_FUN_PROGRAM,
    name: 'create_v2',
    discriminator: [214, 144, 76, 236, 95, 139, 49, 180],
    mintAccount: 0,
  },
  // Meteora DBC: account 2 `creator` (signer), 3 `base_mint` (signer)
  {
    source: 'meteora-dbc',
    program: METEORA_DBC_PROGRAM,
    name: 'initialize_virtual_pool_with_spl_token',
    discriminator: [140, 85, 215, 176, 102, 54, 104, 79],
    mintAccount: 3,
  },
  {
    source: 'meteora-dbc',
    program: METEORA_DBC_PROGRAM,
    name: 'initialize_virtual_pool_with_token2022',
    discriminator: [169, 118, 51, 78, 145, 110, 220, 155],
    mintAccount: 3,
  },
  {
    source: 'meteora-dbc',
    program: METEORA_DBC_PROGRAM,
    name: 'initialize_virtual_pool_with_token2022_transfer_hook',
    discriminator: [182, 13, 233, 177, 42, 145, 135, 2],
    mintAccount: 3,
  },
  // Raydium LaunchLab: account 0 `payer` (signer), 6 `base_mint` (signer)
  {
    source: 'raydium-launchlab',
    program: RAYDIUM_LAUNCHLAB_PROGRAM,
    name: 'initialize',
    discriminator: [175, 175, 109, 31, 13, 152, 155, 237],
    mintAccount: 6,
  },
  {
    source: 'raydium-launchlab',
    program: RAYDIUM_LAUNCHLAB_PROGRAM,
    name: 'initialize_v2',
    discriminator: [67, 153, 175, 39, 218, 16, 38, 32],
    mintAccount: 6,
  },
  {
    source: 'raydium-launchlab',
    program: RAYDIUM_LAUNCHLAB_PROGRAM,
    name: 'initialize_with_token_2022',
    discriminator: [37, 190, 126, 222, 44, 154, 171, 17],
    mintAccount: 6,
  },
];

/** SPL Token / Token-2022: `InitializeMint` and `InitializeMint2`, mint is account 0. */
export const TOKEN_PROGRAMS: ReadonlySet<string> = new Set([TOKEN_PROGRAM, TOKEN_2022_PROGRAM]);
export const INITIALIZE_MINT_TAGS: ReadonlySet<number> = new Set([0, 20]);

/** pump.fun `CreateEvent` (Anchor event: 8-byte discriminator, then Borsh). */
export const PUMP_CREATE_EVENT = [27, 114, 169, 77, 222, 235, 99, 118] as const;

/** Mints that are never a new launch. */
export const KNOWN_MINTS: ReadonlySet<string> = new Set([
  'So11111111111111111111111111111111111111112', // wrapped SOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);
