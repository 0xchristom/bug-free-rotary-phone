/**
 * Keystore file format v1 (SPEC 3.1): types, strict validation and (de)serialization
 * of the encrypted secrets. Validation never echoes file contents into errors (D-008).
 */
import { base58, base64 } from '@scure/base';
import { MAX_FLEET_SIZE, solanaDerivationPath } from '../derivation.ts';
import { AppError } from '../errors.ts';
import type { CipherParams, KdfParams } from './crypto.ts';
import { MAX_KEYSTORE_FILE_BYTES, isValidFleetName } from './limits.ts';
import {
  DEFAULT_GLOBAL_SETTINGS,
  isValidEndpointUrl,
  validateGlobalSettings,
  type GlobalSettingsV1,
  type SettingsField,
} from '../settings.ts';

export { MAX_KEYSTORE_FILE_BYTES, isValidFleetName } from './limits.ts';

export const KEYSTORE_VERSION = 1;
export const MAX_LABEL_LENGTH = 32;
export const MAX_API_KEY_LENGTH = 512;
const U64_MAX = 2n ** 64n - 1n;
const ADDRESS_BYTES = 32;
const SECRET_KEY_BYTES = 64;

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

/** Per-wallet "active" flag (SPEC 3.2); wallets without an entry are active. */
export interface WalletActiveV1 {
  readonly index: number;
  readonly active: boolean;
}

/**
 * Settings inside the encrypted part. `active` and `global` were added in BUNNDLY-15
 * without a version bump (no real files existed yet, D-019); missing ones read as the
 * defaults. From the first real use on, any format change means a new version.
 */
export interface FleetSettingsV1 {
  /** Per-wallet max spend; wallets without an entry have none set yet. */
  readonly maxSpend: readonly MaxSpendV1[];
  readonly active: readonly WalletActiveV1[];
  readonly global: GlobalSettingsV1;
  /**
   * Global settings that were out of the current range in the file and were replaced by
   * the defaults when reading it (D-019). Only present after reading such a file; it is
   * never written and disappears with the next save.
   */
  readonly resetFields?: readonly SettingsField[];
}

export function defaultFleetSettings(): FleetSettingsV1 {
  return { maxSpend: [], active: [], global: DEFAULT_GLOBAL_SETTINGS };
}

/** Secrets that never leave the vault worker (D-016). Custom Helius URLs contain the key. */
export interface ApiKeysV1 {
  readonly helius?: string;
  readonly jupiter?: string;
  readonly heliusRpcUrl?: string;
  readonly heliusWsUrl?: string;
}

export const API_KEY_NAMES = ['helius', 'jupiter', 'heliusRpcUrl', 'heliusWsUrl'] as const;
export type ApiKeyName = (typeof API_KEY_NAMES)[number];

/** True if the value is acceptable for that API key slot (also used by the worker). */
export function isValidApiKeyValue(name: ApiKeyName, value: string): boolean {
  switch (name) {
    case 'heliusRpcUrl':
      return isValidEndpointUrl(value, 'https:');
    case 'heliusWsUrl':
      return isValidEndpointUrl(value, 'wss:');
    default:
      return value.length > 0 && value.length <= MAX_API_KEY_LENGTH && !/[\p{Cc}\s]/u.test(value);
  }
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

function expectBoolean(value: unknown): boolean {
  return typeof value === 'boolean' ? value : invalid();
}

const GLOBAL_KEYS = Object.keys(DEFAULT_GLOBAL_SETTINGS) as (keyof GlobalSettingsV1)[];

/**
 * Missing keys take the defaults. Present values outside the current range (or of the
 * wrong type) also take the defaults and are reported in `resets`: the file is
 * authenticated, so such a value can only come from an older app version, and a changed
 * range must never lock anyone out of their fleet (D-019). Unknown keys stay invalid.
 */
function parseGlobalSettings(value: unknown): {
  global: GlobalSettingsV1;
  resets: SettingsField[];
} {
  if (value === undefined) return { global: DEFAULT_GLOBAL_SETTINGS, resets: [] };
  const g = expectKeys(value, [], GLOBAL_KEYS);
  const merged: Record<string, unknown> = { ...DEFAULT_GLOBAL_SETTINGS };
  for (const key of GLOBAL_KEYS) {
    if (!(key in g)) continue;
    if (key === 'minReserveLamports') {
      try {
        merged[key] = expectLamports(g[key]);
      } catch {
        merged[key] = undefined; // reported as a reset below
      }
    } else {
      merged[key] = g[key];
    }
  }
  const resets = new Set<SettingsField>();
  // Each round resets the reported fields; relations (backoff, plan/limit) settle in two.
  for (let round = 0; round < GLOBAL_KEYS.length; round++) {
    const problems = validateGlobalSettings(merged as unknown as GlobalSettingsV1);
    if (problems.length === 0) break;
    for (const { field } of problems) {
      merged[field] = DEFAULT_GLOBAL_SETTINGS[field];
      resets.add(field);
      // Fields checked together are reset together, so the pair is consistent again.
      if (field === 'orderRpm' || field === 'jupiterPlan') {
        merged.jupiterPlan = DEFAULT_GLOBAL_SETTINGS.jupiterPlan;
        merged.orderRpm = DEFAULT_GLOBAL_SETTINGS.orderRpm;
      }
      if (field === 'noRouteBackoffMaxMs' || field === 'noRouteBackoffMinMs') {
        merged.noRouteBackoffMinMs = DEFAULT_GLOBAL_SETTINGS.noRouteBackoffMinMs;
        merged.noRouteBackoffMaxMs = DEFAULT_GLOBAL_SETTINGS.noRouteBackoffMaxMs;
        resets.add('noRouteBackoffMinMs');
        resets.add('noRouteBackoffMaxMs');
      }
    }
  }
  return { global: merged as unknown as GlobalSettingsV1, resets: [...resets] };
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

  const settings = expectKeys(s.settings, ['maxSpend'], ['active', 'global']);
  if (!Array.isArray(settings.maxSpend)) return invalid();
  const rawMaxSpend: unknown[] = settings.maxSpend;
  const maxSpend = rawMaxSpend.map((value) => {
    const m = expectKeys(value, ['index', 'lamports']);
    return { index: expectIndex(m.index), lamports: expectLamports(m.lamports) };
  });
  expectUniqueIndices(maxSpend);
  const walletIndices = new Set(wallets.map((w) => w.index));
  if (!maxSpend.every((m) => walletIndices.has(m.index))) invalid();

  let active: WalletActiveV1[] = [];
  if (settings.active !== undefined) {
    if (!Array.isArray(settings.active)) return invalid();
    const rawActive: unknown[] = settings.active;
    active = rawActive.map((value) => {
      const a = expectKeys(value, ['index', 'active']);
      return { index: expectIndex(a.index), active: expectBoolean(a.active) };
    });
    expectUniqueIndices(active);
    if (!active.every((a) => walletIndices.has(a.index))) invalid();
  }
  const { global, resets } = parseGlobalSettings(settings.global);

  const keys = expectKeys(s.apiKeys, [], API_KEY_NAMES);
  const apiKeys: { -readonly [K in ApiKeyName]?: string } = {};
  for (const name of API_KEY_NAMES) {
    if (!(name in keys)) continue;
    const value = expectString(keys[name]);
    if (!isValidApiKeyValue(name, value)) invalid();
    apiKeys[name] = value;
  }

  return {
    mnemonic,
    wallets,
    settings: { maxSpend, active, global, ...(resets.length > 0 ? { resetFields: resets } : {}) },
    apiKeys,
  };
}

/** JSON with lamports as decimal strings (bigint is not JSON-serializable). */
export function secretsToJson(secrets: KeystoreSecretsV1): string {
  const { global } = secrets.settings;
  const apiKeys: Partial<Record<ApiKeyName, string>> = {};
  for (const name of API_KEY_NAMES) {
    const value = secrets.apiKeys[name];
    if (value !== undefined) apiKeys[name] = value;
  }
  return JSON.stringify({
    mnemonic: secrets.mnemonic,
    wallets: secrets.wallets.map((w) => ({ index: w.index, secretKey: w.secretKey })),
    settings: {
      maxSpend: secrets.settings.maxSpend.map((m) => ({
        index: m.index,
        lamports: m.lamports.toString(),
      })),
      active: secrets.settings.active.map((a) => ({ index: a.index, active: a.active })),
      global: { ...global, minReserveLamports: global.minReserveLamports.toString() },
    },
    apiKeys,
  });
}
