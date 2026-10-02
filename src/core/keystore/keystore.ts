/**
 * Creating, building and opening keystores (SPEC 3.1).
 *
 * The `public` part of the file is plaintext and not signed. After decryption every
 * public address is checked against the private key and against the mnemonic for its
 * index; any mismatch is KEYSTORE_TAMPERED, so a swapped deposit address in the file
 * can never be shown to the user as their own.
 */
import { base58 } from '@scure/base';
import {
  deriveWallets,
  generateMnemonic,
  parseMnemonic,
  secretKeyToBase58,
  solanaDerivationPath,
  wipe,
} from '../derivation.ts';
import { AppError, isAppError } from '../errors.ts';
import {
  MIN_PASSWORD_LENGTH,
  createSession,
  encryptWithSession,
  passwordLength,
  unlockSession,
  type CryptoOptions,
  type KeystoreSession,
} from './crypto.ts';
import {
  KEYSTORE_VERSION,
  defaultFleetSettings,
  isValidFleetName,
  parseSecrets,
  secretsToJson,
  type KeystoreFileV1,
  type KeystoreSecretsV1,
  type PublicWalletV1,
} from './format.ts';

export interface KeystoreMeta {
  readonly fleetName: string;
  /** Defaults to now. */
  readonly createdAt?: Date;
  /** Labels by wallet index; missing ones get the default (W01, W02, …). */
  readonly labels?: ReadonlyMap<number, string>;
}

export interface CreateKeystoreParams extends CryptoOptions {
  readonly fleetName: string;
  readonly walletCount: number;
  readonly password: string;
  /** Import an existing mnemonic (12–24 words); otherwise a new 24-word one is generated. */
  readonly mnemonic?: string;
}

export interface OpenedKeystore {
  readonly file: KeystoreFileV1;
  readonly secrets: KeystoreSecretsV1;
  /** Derived key + KDF parameters, for re-encrypting without the password. */
  readonly session: KeystoreSession;
}

/** W01, W02, …, W99, W100. */
export function defaultWalletLabel(index: number): string {
  return `W${String(index + 1).padStart(2, '0')}`;
}

function tampered(): never {
  throw new AppError('KEYSTORE_TAMPERED');
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/**
 * Checks that every wallet in `secrets` is derived from its mnemonic at its index and,
 * if `publicWallets` is given, that the public list has the same indices and addresses.
 * Returns the address per index. Throws KEYSTORE_TAMPERED or KEYSTORE_INVALID_FORMAT.
 */
function verifySecrets(
  secrets: KeystoreSecretsV1,
  publicWallets?: readonly PublicWalletV1[],
): Map<number, string> {
  let mnemonic: string;
  try {
    mnemonic = parseMnemonic(secrets.mnemonic);
  } catch {
    throw new AppError('KEYSTORE_INVALID_FORMAT');
  }
  if (secrets.wallets.length === 0) throw new AppError('KEYSTORE_INVALID_FORMAT');
  const maxIndex = Math.max(...secrets.wallets.map((w) => w.index));
  const derived = deriveWallets(mnemonic, 0, maxIndex + 1);
  const addresses = new Map<number, string>();
  try {
    for (const wallet of secrets.wallets) {
      const expected = derived[wallet.index];
      const stored = base58.decode(wallet.secretKey);
      try {
        const publicKey = stored.slice(32);
        if (expected === undefined || !bytesEqual(stored, expected.secretKey)) tampered();
        if (base58.encode(publicKey) !== expected.address) tampered();
        addresses.set(wallet.index, expected.address);
      } finally {
        wipe(stored);
      }
    }
  } finally {
    for (const w of derived) wipe(w.secretKey);
  }
  if (publicWallets !== undefined) {
    if (publicWallets.length !== addresses.size) tampered();
    for (const pub of publicWallets) {
      if (addresses.get(pub.index) !== pub.address) tampered();
      if (pub.derivationPath !== solanaDerivationPath(pub.index)) tampered();
    }
  }
  return addresses;
}

/**
 * Encrypts ready-made secrets into a keystore file with an existing session (same KDF
 * parameters and salt, fresh IV). Used by the vault to save settings or add wallets
 * without the password. The public part is computed from the secrets, never taken
 * from the caller.
 */
export async function buildKeystoreWithSession(
  secrets: KeystoreSecretsV1,
  meta: KeystoreMeta,
  session: KeystoreSession,
): Promise<KeystoreFileV1> {
  if (!isValidFleetName(meta.fleetName)) throw new AppError('INVALID_FLEET_NAME');
  // Round-trip through the validator so only well-formed secrets are ever encrypted.
  const json = secretsToJson(secrets);
  const normalized = parseSecrets(JSON.parse(json));
  const addresses = verifySecrets(normalized);

  const wallets: PublicWalletV1[] = [...addresses.keys()]
    .sort((a, b) => a - b)
    .map((index) => ({
      index,
      address: addresses.get(index) ?? tampered(),
      derivationPath: solanaDerivationPath(index),
      label: meta.labels?.get(index) ?? defaultWalletLabel(index),
    }));

  const plaintext = new TextEncoder().encode(json);
  try {
    const encrypted = await encryptWithSession(plaintext, session);
    return {
      version: KEYSTORE_VERSION,
      fleetName: meta.fleetName,
      createdAt: (meta.createdAt ?? new Date()).toISOString(),
      kdf: encrypted.kdf,
      cipher: encrypted.cipher,
      ciphertext: encrypted.ciphertext,
      public: { wallets },
    };
  } finally {
    wipe(plaintext);
  }
}

/**
 * Encrypts ready-made secrets into a keystore file under a new password (new salt).
 * Validates the fleet name, password and secrets before running scrypt.
 */
export async function buildKeystore(
  secrets: KeystoreSecretsV1,
  meta: KeystoreMeta,
  password: string,
  options: CryptoOptions = {},
): Promise<KeystoreFileV1> {
  return (await buildKeystoreSession(secrets, meta, password, options)).file;
}

async function buildKeystoreSession(
  secrets: KeystoreSecretsV1,
  meta: KeystoreMeta,
  password: string,
  options: CryptoOptions,
): Promise<{ file: KeystoreFileV1; session: KeystoreSession }> {
  if (!isValidFleetName(meta.fleetName)) throw new AppError('INVALID_FLEET_NAME');
  if (passwordLength(password) < MIN_PASSWORD_LENGTH) throw new AppError('PASSWORD_TOO_SHORT');
  // Fail on bad secrets before the expensive scrypt.
  verifySecrets(parseSecrets(JSON.parse(secretsToJson(secrets))));
  const session = await createSession(password, options);
  return { file: await buildKeystoreWithSession(secrets, meta, session), session };
}

/**
 * New fleet: wallets 0..walletCount-1 from a new 24-word mnemonic or an imported one.
 * Returns the file, the secrets and the session for the vault worker. The UI never
 * shows the mnemonic; a backup goes only through the explicit export (BUNNDLY-11).
 */
export async function createKeystore(params: CreateKeystoreParams): Promise<OpenedKeystore> {
  if (!isValidFleetName(params.fleetName)) throw new AppError('INVALID_FLEET_NAME');
  if (passwordLength(params.password) < MIN_PASSWORD_LENGTH) {
    throw new AppError('PASSWORD_TOO_SHORT');
  }
  const mnemonic =
    params.mnemonic === undefined ? generateMnemonic() : parseMnemonic(params.mnemonic);
  const derived = deriveWallets(mnemonic, 0, params.walletCount);
  let wallets: KeystoreSecretsV1['wallets'];
  try {
    wallets = derived.map((w) => ({ index: w.index, secretKey: secretKeyToBase58(w.secretKey) }));
  } finally {
    for (const w of derived) wipe(w.secretKey);
  }
  const secrets: KeystoreSecretsV1 = {
    mnemonic,
    wallets,
    settings: defaultFleetSettings(),
    apiKeys: {},
  };
  const options = params.onProgress ? { onProgress: params.onProgress } : {};
  const { file, session } = await buildKeystoreSession(
    secrets,
    { fleetName: params.fleetName },
    params.password,
    options,
  );
  return { file, secrets, session };
}

/**
 * Decrypts and validates a parsed keystore file, then checks that every public address
 * matches the decrypted keys and the mnemonic. Errors: KEYSTORE_UNSUPPORTED_KDF,
 * KEYSTORE_WRONG_PASSWORD_OR_CORRUPTED, KEYSTORE_INVALID_FORMAT, KEYSTORE_TAMPERED.
 */
export async function openKeystore(
  file: KeystoreFileV1,
  password: string,
  options: CryptoOptions = {},
): Promise<OpenedKeystore> {
  const { plaintext, session } = await unlockSession(
    { kdf: file.kdf, cipher: file.cipher, ciphertext: file.ciphertext },
    password,
    options,
  );
  let secrets: KeystoreSecretsV1;
  try {
    secrets = parseSecrets(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)));
  } catch (e) {
    if (isAppError(e)) throw e;
    throw new AppError('KEYSTORE_INVALID_FORMAT');
  } finally {
    wipe(plaintext);
  }
  verifySecrets(secrets, file.public.wallets);
  return { file, secrets, session };
}
