/**
 * BIP39 mnemonic and Solana wallet derivation on m/44'/501'/{i}'/0' (SPEC 2.3, 3.1).
 *
 * Derivation is SLIP-0010 for ed25519 with an empty BIP39 passphrase, which gives the
 * same addresses as Phantom, Solflare and `solana-keygen --derivation-path`.
 *
 * Secrets (mnemonic, seed, private keys) never go into error messages (D-008).
 */
import { base58 } from '@scure/base';
import {
  generateMnemonic as bip39Generate,
  mnemonicToSeedSync,
  validateMnemonic as bip39Validate,
} from '@scure/bip39';
import { wordlist as english } from '@scure/bip39/wordlists/english.js';
import { HARDENED_OFFSET, HDKey } from 'micro-key-producer/slip10.js';
import { AppError } from './errors.ts';

/** Maximum number of wallets in a fleet; indices are 0..MAX_FLEET_SIZE-1. */
export const MAX_FLEET_SIZE = 100;

/** Entropy for newly generated mnemonics: 256 bits = 24 words. */
const GENERATED_STRENGTH_BITS = 256;

const SOLANA_PURPOSE = 44;
const SOLANA_COIN_TYPE = 501;

const SECRET_KEY_LENGTH = 64;
const PRIVATE_KEY_LENGTH = 32;

export interface DerivedWallet {
  readonly index: number;
  /** e.g. `m/44'/501'/0'/0'` */
  readonly derivationPath: string;
  /** base58 of the 32-byte ed25519 public key. */
  readonly address: string;
  /** 64 bytes: 32-byte private seed followed by the 32-byte public key. Wipe after use. */
  readonly secretKey: Uint8Array;
}

/** NFKD, lower case, trimmed, single spaces between words. */
export function normalizeMnemonic(input: string): string {
  return input.normalize('NFKD').toLowerCase().trim().split(/\s+/u).join(' ');
}

/** New 24-word English BIP39 mnemonic. */
export function generateMnemonic(): string {
  return bip39Generate(english, GENERATED_STRENGTH_BITS);
}

/** True for any valid English BIP39 mnemonic (12–24 words) after normalization. */
export function validateMnemonic(input: string): boolean {
  return bip39Validate(normalizeMnemonic(input), english);
}

/** Returns the normalized mnemonic or throws INVALID_MNEMONIC (without the input). */
export function parseMnemonic(input: string): string {
  const normalized = normalizeMnemonic(input);
  if (!bip39Validate(normalized, english)) {
    throw new AppError('INVALID_MNEMONIC');
  }
  return normalized;
}

export function solanaDerivationPath(index: number): string {
  return `m/${String(SOLANA_PURPOSE)}'/${String(SOLANA_COIN_TYPE)}'/${String(index)}'/0'`;
}

function assertFleetRange(fromIndex: number, count: number): void {
  if (
    !Number.isSafeInteger(fromIndex) ||
    !Number.isSafeInteger(count) ||
    fromIndex < 0 ||
    count < 1 ||
    fromIndex + count > MAX_FLEET_SIZE
  ) {
    throw new AppError('INVALID_DERIVATION_INDEX');
  }
}

/**
 * SLIP-0010 ed25519 derivation along an all-hardened path. `path` holds child indices
 * without the hardened offset, e.g. [44, 501, 0, 0]. Intermediate keys are wiped.
 */
export function deriveSlip10Ed25519(
  seed: Uint8Array,
  path: readonly number[],
): { privateKey: Uint8Array; chainCode: Uint8Array } {
  let key = HDKey.fromMasterSeed(seed);
  for (const index of path) {
    if (!Number.isInteger(index) || index < 0 || index >= HARDENED_OFFSET) {
      wipe(key.privateKey, key.chainCode);
      throw new AppError('INVALID_DERIVATION_INDEX');
    }
    const child = key.deriveChild(HARDENED_OFFSET + index);
    wipe(key.privateKey, key.chainCode);
    key = child;
  }
  return { privateKey: key.privateKey, chainCode: key.chainCode };
}

/**
 * Derives wallets fromIndex..fromIndex+count-1 on m/44'/501'/{i}'/0' with an empty
 * BIP39 passphrase. Throws INVALID_DERIVATION_INDEX or INVALID_MNEMONIC.
 */
export function deriveWallets(mnemonic: string, fromIndex: number, count: number): DerivedWallet[] {
  assertFleetRange(fromIndex, count);
  const seed = mnemonicToSeedSync(parseMnemonic(mnemonic), '');
  try {
    const wallets: DerivedWallet[] = [];
    for (let index = fromIndex; index < fromIndex + count; index++) {
      const { privateKey, chainCode } = deriveSlip10Ed25519(seed, [
        SOLANA_PURPOSE,
        SOLANA_COIN_TYPE,
        index,
        0,
      ]);
      const publicKey = new HDKey({ privateKey, chainCode }).publicKeyRaw;
      const secretKey = new Uint8Array(SECRET_KEY_LENGTH);
      secretKey.set(privateKey, 0);
      secretKey.set(publicKey, PRIVATE_KEY_LENGTH);
      wipe(privateKey, chainCode);
      wallets.push({
        index,
        derivationPath: solanaDerivationPath(index),
        address: base58.encode(publicKey),
        secretKey,
      });
    }
    return wallets;
  } finally {
    wipe(seed);
  }
}

/** Private key in the format Phantom imports: base58 of the 64-byte secret key. */
export function secretKeyToBase58(secretKey: Uint8Array): string {
  if (secretKey.length !== SECRET_KEY_LENGTH) {
    throw new RangeError('secretKey must be 64 bytes');
  }
  return base58.encode(secretKey);
}

/** Overwrites buffers holding secrets with zeros (best effort: JS may keep copies). */
export function wipe(...buffers: Uint8Array[]): void {
  for (const buffer of buffers) {
    buffer.fill(0);
  }
}
