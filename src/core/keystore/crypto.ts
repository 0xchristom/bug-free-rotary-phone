/**
 * Password-based encryption of keystore secrets: scrypt (KDF) + AES-256-GCM (SPEC 3.1, 6.3).
 *
 * Parameters read from a file are validated before scrypt runs, so a malicious file
 * cannot hang the browser with a huge work factor. A wrong password and tampered data
 * produce the same error (GCM cannot tell them apart). No secret ever goes into an error.
 */
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { base64 } from '@scure/base';
import { AppError } from '../errors.ts';

export const MIN_PASSWORD_LENGTH = 12;

export const DEFAULT_SCRYPT_N = 2 ** 17;
export const MIN_SCRYPT_N = 2 ** 17;
export const MAX_SCRYPT_N = 2 ** 20;
export const SCRYPT_R = 8;
export const MIN_SCRYPT_P = 1;
export const MAX_SCRYPT_P = 4;

const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const KEY_LENGTH = 32;
const TAG_LENGTH_BITS = 128;
const TAG_LENGTH = TAG_LENGTH_BITS / 8;

export interface KdfParams {
  readonly name: 'scrypt';
  readonly N: number;
  readonly r: number;
  readonly p: number;
  /** base64, 16 bytes */
  readonly salt: string;
}

export interface CipherParams {
  readonly name: 'AES-GCM';
  /** base64, 12 bytes */
  readonly iv: string;
}

/** The `kdf`, `cipher` and `ciphertext` fields of the keystore file (SPEC 3.1). */
export interface EncryptedSecrets {
  readonly kdf: KdfParams;
  readonly cipher: CipherParams;
  /** base64 of AES-GCM ciphertext followed by the 16-byte tag */
  readonly ciphertext: string;
}

export interface ScryptCost {
  readonly N?: number;
  readonly p?: number;
}

export interface CryptoOptions {
  /** scrypt progress in 0..1, for the UI. */
  readonly onProgress?: (progress: number) => void;
}

export interface EncryptOptions extends CryptoOptions {
  /** Override the work factor (within the allowed range). r is fixed at 8. */
  readonly kdf?: ScryptCost;
}

interface ValidatedKdf {
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly salt: Uint8Array;
}

/** Non-extractable AES-256-GCM key (type spelled this way to work without DOM typings). */
export type AesKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

/**
 * An unlocked keystore: the derived key plus the KDF parameters it came from. Lets the
 * vault re-encrypt (new IV, same salt) without keeping the password (BUNNDLY-7).
 */
export interface KeystoreSession {
  readonly key: AesKey;
  readonly kdf: KdfParams;
}

function isPowerOfTwo(n: number): boolean {
  return Number.isSafeInteger(n) && n > 0 && (n & (n - 1)) === 0;
}

function decodeBase64(value: unknown): Uint8Array | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return base64.decode(value);
  } catch {
    return undefined;
  }
}

function validCost(N: unknown, r: unknown, p: unknown): boolean {
  return (
    typeof N === 'number' &&
    isPowerOfTwo(N) &&
    N >= MIN_SCRYPT_N &&
    N <= MAX_SCRYPT_N &&
    r === SCRYPT_R &&
    typeof p === 'number' &&
    Number.isSafeInteger(p) &&
    p >= MIN_SCRYPT_P &&
    p <= MAX_SCRYPT_P
  );
}

function unsupported(): never {
  throw new AppError('KEYSTORE_UNSUPPORTED_KDF');
}

/** Throws KEYSTORE_UNSUPPORTED_KDF for anything outside the allowed KDF parameter set. */
function validateKdf(kdf: unknown): ValidatedKdf {
  if (typeof kdf !== 'object' || kdf === null) return unsupported();
  const k = kdf as Partial<Record<keyof KdfParams, unknown>>;
  if (k.name !== 'scrypt' || !validCost(k.N, k.r, k.p)) return unsupported();
  const salt = decodeBase64(k.salt);
  if (salt?.length !== SALT_LENGTH) return unsupported();
  return { N: k.N as number, r: SCRYPT_R, p: k.p as number, salt };
}

/** Throws KEYSTORE_UNSUPPORTED_KDF unless the cipher is AES-GCM with a 12-byte IV. */
function validateCipher(cipher: unknown): Uint8Array<ArrayBuffer> {
  if (typeof cipher !== 'object' || cipher === null) return unsupported();
  const c = cipher as Partial<Record<keyof CipherParams, unknown>>;
  if (c.name !== 'AES-GCM') return unsupported();
  const iv = decodeBase64(c.iv);
  if (iv?.length !== IV_LENGTH) return unsupported();
  return new Uint8Array(iv);
}

/** User-perceived characters (grapheme clusters) after NFKC. */
export function passwordLength(password: string): number {
  return Array.from(new Intl.Segmenter().segment(password.normalize('NFKC'))).length;
}

/** NFKC, then UTF-8 (SPEC 3.1). */
function passwordBytes(password: string): Uint8Array {
  return new TextEncoder().encode(password.normalize('NFKC'));
}

async function deriveAesKey(
  password: string,
  params: ValidatedKdf,
  onProgress: ((progress: number) => void) | undefined,
): Promise<AesKey> {
  const pw = passwordBytes(password);
  let derived: Uint8Array | undefined;
  let keyBytes: Uint8Array<ArrayBuffer> | undefined;
  try {
    derived = await scryptAsync(pw, params.salt, {
      N: params.N,
      r: params.r,
      p: params.p,
      dkLen: KEY_LENGTH,
      // noble's memory formula; bounded by the validated N, r, p (≈1 GiB at the max).
      maxmem: 128 * params.r * (params.N + params.p + 1),
      ...(onProgress ? { onProgress } : {}),
    });
    keyBytes = new Uint8Array(derived);
    return await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  } finally {
    pw.fill(0);
    derived?.fill(0);
    keyBytes?.fill(0);
  }
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
}

function decodeSealed(ciphertext: unknown): Uint8Array<ArrayBuffer> {
  const sealed = decodeBase64(ciphertext);
  if (sealed === undefined || sealed.length < TAG_LENGTH) {
    throw new AppError('KEYSTORE_WRONG_PASSWORD_OR_CORRUPTED');
  }
  return new Uint8Array(sealed);
}

/**
 * New session for a new password: fresh 16-byte salt, default (or given) cost.
 * Requires at least MIN_PASSWORD_LENGTH characters (after NFKC), else PASSWORD_TOO_SHORT.
 */
export async function createSession(
  password: string,
  options: EncryptOptions = {},
): Promise<KeystoreSession> {
  if (passwordLength(password) < MIN_PASSWORD_LENGTH) {
    throw new AppError('PASSWORD_TOO_SHORT');
  }
  const kdf: KdfParams = {
    name: 'scrypt',
    N: options.kdf?.N ?? DEFAULT_SCRYPT_N,
    r: SCRYPT_R,
    p: options.kdf?.p ?? MIN_SCRYPT_P,
    salt: base64.encode(randomBytes(SALT_LENGTH)),
  };
  const key = await deriveAesKey(password, validateKdf(kdf), options.onProgress);
  return { key, kdf };
}

/** Encrypts with the session key and a fresh random 12-byte IV. */
export async function encryptWithSession(
  plaintext: Uint8Array,
  session: KeystoreSession,
): Promise<EncryptedSecrets> {
  validateKdf(session.kdf);
  const iv = randomBytes(IV_LENGTH);
  const plainCopy = new Uint8Array(plaintext);
  try {
    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, tagLength: TAG_LENGTH_BITS },
      session.key,
      plainCopy,
    );
    return {
      kdf: session.kdf,
      cipher: { name: 'AES-GCM', iv: base64.encode(iv) },
      ciphertext: base64.encode(new Uint8Array(sealed)),
    };
  } finally {
    plainCopy.fill(0);
  }
}

/**
 * Decrypts with an existing session (no scrypt). The data must have been encrypted
 * under the same KDF parameters; any mismatch or tampering gives
 * KEYSTORE_WRONG_PASSWORD_OR_CORRUPTED. The caller must wipe the result.
 */
export async function decryptWithSession(
  encrypted: EncryptedSecrets,
  session: KeystoreSession,
): Promise<Uint8Array> {
  const iv = validateCipher(encrypted.cipher);
  const sealed = decodeSealed(encrypted.ciphertext);
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, tagLength: TAG_LENGTH_BITS },
      session.key,
      sealed,
    );
    return new Uint8Array(plain);
  } catch {
    // OperationError from GCM: wrong key or modified data. No cause, no details.
    throw new AppError('KEYSTORE_WRONG_PASSWORD_OR_CORRUPTED');
  }
}

/**
 * Derives the session from `password` and the file's KDF parameters and decrypts.
 * Unsupported parameters give KEYSTORE_UNSUPPORTED_KDF before any scrypt work.
 */
export async function unlockSession(
  encrypted: EncryptedSecrets,
  password: string,
  options: CryptoOptions = {},
): Promise<{ plaintext: Uint8Array; session: KeystoreSession }> {
  const params = validateKdf(encrypted.kdf);
  validateCipher(encrypted.cipher);
  decodeSealed(encrypted.ciphertext);
  const key = await deriveAesKey(password, params, options.onProgress);
  const session: KeystoreSession = { key, kdf: encrypted.kdf };
  return { plaintext: await decryptWithSession(encrypted, session), session };
}

/** Encrypts `plaintext` under a new session for `password` (see createSession). */
export async function encryptSecrets(
  plaintext: Uint8Array,
  password: string,
  options: EncryptOptions = {},
): Promise<EncryptedSecrets> {
  return encryptWithSession(plaintext, await createSession(password, options));
}

/**
 * Decrypts secrets produced by encryptSecrets. Unsupported parameters give
 * KEYSTORE_UNSUPPORTED_KDF before any scrypt work; a wrong password or any tampering
 * gives KEYSTORE_WRONG_PASSWORD_OR_CORRUPTED. The caller must wipe the result.
 */
export async function decryptSecrets(
  encrypted: EncryptedSecrets,
  password: string,
  options: CryptoOptions = {},
): Promise<Uint8Array> {
  return (await unlockSession(encrypted, password, options)).plaintext;
}
