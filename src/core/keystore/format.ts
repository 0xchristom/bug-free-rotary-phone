/**
 * Keystore file format v1 (SPEC 3.1): types, strict validation and (de)serialization
 * of the encrypted secrets. Validation never echoes file contents into errors (D-008).
 */
import { base58, base64 } from '@scure/base';
import { MAX_FLEET_SIZE, solanaDerivationPath } from '../derivation.ts';
import { AppError } from '../errors.ts';
import type { CipherParams, KdfParams } from './crypto.ts';

export const KEYSTORE_VERSION = 1;
/** Files above this size are rejected before JSON.parse. */
export const MAX_KEYSTORE_FILE_BYTES = 1024 * 1024;
export const MAX_LABEL_LENGTH = 32;
export const MAX_API_KEY_LENGTH = 512;
const U64_MAX = 2n ** 64n - 1n;
const ADDRESS_BYTES = 32;
const SECRET_KEY_BYTES = 64;

/**
 * Fleet name, used as `<fleetName>.keystore.json`: 1–64 letters, digits, spaces, dots,
 * hyphens or underscores; no leading dot or space, no trailing dot or space.
 */
const FLEET_NAME_RE = /^(?![. ])[\p{L}\p{N} ._-]{1,64}(?<![. ])$/u;

export interface PublicWalletV1 {
  readonly index: number;
  readonly address: string;
  readonly derivationPath: string;
  readonly label: string;
}

/** Exactly the fields of SPEC 3.1. */
export interface KeystoreFileV1 {
  readonly version: 1;
  readonly fleetName: string;
  /** ISO-8601 */
  readonly createdAt: string;
  readonly kdf: KdfParams;
  readonly cipher: CipherParams;
  readonly ciphertext: string;
  readonly public: { readonly wallets: readonly PublicWalletV1[] };
}

export interface SecretWalletV1 {
  readonly index: number;
  /** base58 of the 64-byte secret key (Phantom import format). */
  readonly secretKey: string;
}

export interface MaxSpendV1 {
  readonly index: number;
  readonly lamports: bigint;
}

export interface FleetSettingsV1 {
  /** Per-wallet max spend; wallets without an entry have none set yet. */
  readonly maxSpend: readonly MaxSpendV1[];
}

export interface ApiKeysV1 {
  readonly helius?: string;
  readonly jupiter?: string;
}

/** Plaintext inside `ciphertext`. */
export interface KeystoreSecretsV1 {
  readonly mnemonic: string;
  readonly wallets: readonly SecretWalletV1[];
  readonly settings: FleetSettingsV1;
  readonly apiKeys: ApiKeysV1;
}

type Json = Record<string, unknown>;

function invalid(): never {
  throw new AppError('KEYSTORE_INVALID_FORMAT');
}

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Object with exactly the required keys plus any of the optional ones. */
function expectKeys(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Json {
  if (!isObject(value)) return invalid();
  const keys = Object.keys(value);
  if (!required.every((k) => keys.includes(k))) return invalid();
  if (!keys.every((k) => required.includes(k) || optional.includes(k))) return invalid();
  return value;
}

function expectString(value: unknown): string {
  return typeof value === 'string' ? value : invalid();
}

function expectIndex(value: unknown): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < MAX_FLEET_SIZE
    ? value
    : invalid();
}

function expectBase64(value: unknown): string {
  const s = expectString(value);
  try {
    base64.decode(s);
  } catch {
    return invalid();
  }
  return s;
}

function expectBase58Bytes(value: unknown, length: number): string {
  const s = expectString(value);
  let bytes: Uint8Array;
  try {
    bytes = base58.decode(s);
  } catch {
    return invalid();
  }
  const ok = bytes.length === length;
  bytes.fill(0);
  return ok ? s : invalid();
}

export function isValidFleetName(name: string): boolean {
  return FLEET_NAME_RE.test(name);
}

function isValidLabel(label: string): boolean {
  return label.length > 0 && label.length <= MAX_LABEL_LENGTH && !/\p{Cc}/u.test(label);
}

function isCanonicalIsoDate(value: string): boolean {
  const ms = Date.parse(value);
  return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

function expectUniqueIndices(items: readonly { readonly index: number }[]): void {
  if (new Set(items.map((i) => i.index)).size !== items.length) invalid();
}

function parsePublicWallet(value: unknown): PublicWalletV1 {
  const w = expectKeys(value, ['index', 'address', 'derivationPath', 'label']);
  const index = expectIndex(w.index);
  const address = expectBase58Bytes(w.address, ADDRESS_BYTES);
  const derivationPath = expectString(w.derivationPath);
  const label = expectString(w.label);
  if (derivationPath !== solanaDerivationPath(index) || !isValidLabel(label)) invalid();
  return { index, address, derivationPath, label };
}

/**
 * Validates the structure of a keystore file without the password, e.g. to preview
 * addresses. Throws KEYSTORE_INVALID_FORMAT or KEYSTORE_UNSUPPORTED_VERSION.
 * Cryptographic parameter ranges are checked later by decryptSecrets.
 */
export function parseKeystoreFile(text: string): KeystoreFileV1 {
  // Cheap bound first (a UTF-16 unit is at least one UTF-8 byte), then the exact size.
  if (
    text.length > MAX_KEYSTORE_FILE_BYTES ||
    new TextEncoder().encode(text).length > MAX_KEYSTORE_FILE_BYTES
  ) {
    return invalid();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return invalid();
  }
  if (!isObject(raw) || !('version' in raw)) return invalid();
  if (raw.version !== KEYSTORE_VERSION) throw new AppError('KEYSTORE_UNSUPPORTED_VERSION');

  const file = expectKeys(raw, [
    'version',
    'fleetName',
    'createdAt',
    'kdf',
    'cipher',
    'ciphertext',
    'public',
  ]);
  const fleetName = expectString(file.fleetName);
  const createdAt = expectString(file.createdAt);
  if (!isValidFleetName(fleetName) || !isCanonicalIsoDate(createdAt)) invalid();

  const kdf = expectKeys(file.kdf, ['name', 'N', 'r', 'p', 'salt']);
  const cipher = expectKeys(file.cipher, ['name', 'iv']);
  if (typeof kdf.N !== 'number' || typeof kdf.r !== 'number' || typeof kdf.p !== 'number') {
    invalid();
  }
  const kdfName = expectString(kdf.name);
  const cipherName = expectString(cipher.name);
  // Unknown algorithm names pass here and are rejected by decryptSecrets as
  // KEYSTORE_UNSUPPORTED_KDF; the cast only narrows the declared type.
  const kdfParams = {
    name: kdfName,
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    salt: expectBase64(kdf.salt),
  } as KdfParams;
  const cipherParams = { name: cipherName, iv: expectBase64(cipher.iv) } as CipherParams;
  const ciphertext = expectBase64(file.ciphertext);

  const pub = expectKeys(file.public, ['wallets']);
  if (!Array.isArray(pub.wallets)) return invalid();
  const rawWallets: unknown[] = pub.wallets;
  if (rawWallets.length < 1 || rawWallets.length > MAX_FLEET_SIZE) return invalid();
  const wallets = rawWallets.map(parsePublicWallet);
  expectUniqueIndices(wallets);

  return {
    version: KEYSTORE_VERSION,
    fleetName,
    createdAt,
    kdf: kdfParams,
    cipher: cipherParams,
    ciphertext,
    public: { wallets },
  };
}

/** Pretty JSON for writing to disk. Key order follows SPEC 3.1. */
export function serializeKeystoreFile(file: KeystoreFileV1): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

function expectLamports(value: unknown): bigint {
  const s = expectString(value);
  if (!/^(0|[1-9][0-9]{0,19})$/u.test(s)) return invalid();
  const n = BigInt(s);
  return n <= U64_MAX ? n : invalid();
}

function parseApiKey(value: unknown): string {
  const s = expectString(value);
  return s.length > 0 && s.length <= MAX_API_KEY_LENGTH ? s : invalid();
}

/**
 * Validates decrypted secrets (the JSON inside `ciphertext`). Throws
 * KEYSTORE_INVALID_FORMAT. Mnemonic validity and key consistency are checked by
 * the caller (openKeystore).
 */
export function parseSecrets(raw: unknown): KeystoreSecretsV1 {
  const s = expectKeys(raw, ['mnemonic', 'wallets', 'settings', 'apiKeys']);
  const mnemonic = expectString(s.mnemonic);
  if (!Array.isArray(s.wallets)) return invalid();
  const rawWallets: unknown[] = s.wallets;
  const wallets = rawWallets.map((value) => {
    const w = expectKeys(value, ['index', 'secretKey']);
    return {
      index: expectIndex(w.index),
      secretKey: expectBase58Bytes(w.secretKey, SECRET_KEY_BYTES),
    };
  });
  expectUniqueIndices(wallets);

  const settings = expectKeys(s.settings, ['maxSpend']);
  if (!Array.isArray(settings.maxSpend)) return invalid();
  const rawMaxSpend: unknown[] = settings.maxSpend;
  const maxSpend = rawMaxSpend.map((value) => {
    const m = expectKeys(value, ['index', 'lamports']);
    return { index: expectIndex(m.index), lamports: expectLamports(m.lamports) };
  });
  expectUniqueIndices(maxSpend);
  const walletIndices = new Set(wallets.map((w) => w.index));
  if (!maxSpend.every((m) => walletIndices.has(m.index))) invalid();

  const keys = expectKeys(s.apiKeys, [], ['helius', 'jupiter']);
  const apiKeys: { helius?: string; jupiter?: string } = {};
  if ('helius' in keys) apiKeys.helius = parseApiKey(keys.helius);
  if ('jupiter' in keys) apiKeys.jupiter = parseApiKey(keys.jupiter);

  return { mnemonic, wallets, settings: { maxSpend }, apiKeys };
}

/** JSON with lamports as decimal strings (bigint is not JSON-serializable). */
export function secretsToJson(secrets: KeystoreSecretsV1): string {
  return JSON.stringify({
    mnemonic: secrets.mnemonic,
    wallets: secrets.wallets.map((w) => ({ index: w.index, secretKey: w.secretKey })),
    settings: {
      maxSpend: secrets.settings.maxSpend.map((m) => ({
        index: m.index,
        lamports: m.lamports.toString(),
      })),
    },
    apiKeys: {
      ...(secrets.apiKeys.helius === undefined ? {} : { helius: secrets.apiKeys.helius }),
      ...(secrets.apiKeys.jupiter === undefined ? {} : { jupiter: secrets.apiKeys.jupiter }),
    },
  });
}
