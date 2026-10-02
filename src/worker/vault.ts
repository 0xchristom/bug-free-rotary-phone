/**
 * Vault: the only place where the mnemonic and private keys exist in plaintext
 * (SPEC 6.1). Pure request handler, testable in Node; vault.worker.ts wires it to the
 * worker's message port and a timer.
 *
 * Secrets are held as byte buffers so lock / auto-lock can zero them. The password is
 * never stored: after unlock the vault keeps the non-extractable AES key and the KDF
 * parameters (KeystoreSession) and re-encrypts with a fresh IV.
 *
 * Security rule (DECISIONS D-013): the API is domain operations only. There is no
 * request to sign arbitrary bytes or to export keys without the password.
 */
import { base58 } from '@scure/base';
import {
  AppError,
  MAX_FLEET_SIZE,
  buildKeystoreWithSession,
  createKeystore,
  deriveWallets,
  isAppError,
  openKeystore,
  parseKeystoreFile,
  secretKeyToBase58,
  serializeKeystoreFile,
  wipe,
  type ApiKeysV1,
  type FleetSettingsV1,
  type KeystoreSecretsV1,
  type KeystoreSession,
  type OpenedKeystore,
  type PublicWalletV1,
} from '../core/index.ts';
import { DEFAULT_AUTO_LOCK_MS } from './protocol.ts';
import type {
  VaultFileResult,
  VaultInfo,
  VaultPort,
  VaultProgressEnvelope,
  VaultRequest,
  VaultRequestType,
  VaultResponseEnvelope,
  VaultResultMap,
  VaultStatus,
} from './protocol.ts';

export { DEFAULT_AUTO_LOCK_MS } from './protocol.ts';

export interface VaultOptions {
  /** Clock in ms; injectable for tests. */
  readonly now?: () => number;
  /** Inactivity before auto-lock; default 15 minutes. */
  readonly autoLockMs?: number;
}

interface SecretWallet {
  readonly index: number;
  /** 64 bytes, zeroed on lock. */
  readonly secretKey: Uint8Array;
}

interface UnlockedVault {
  readonly fleetName: string;
  readonly createdAt: Date;
  /** UTF-8 of the normalized mnemonic, zeroed on lock. */
  readonly mnemonic: Uint8Array;
  readonly wallets: SecretWallet[];
  readonly publicWallets: readonly PublicWalletV1[];
  readonly settings: FleetSettingsV1;
  readonly apiKeys: ApiKeysV1;
  readonly session: KeystoreSession;
}

/** Internal state, exposed read-only for tests (e.g. to check that buffers are zeroed). */
export interface VaultState {
  readonly unlocked: UnlockedVault | null;
  readonly armed: boolean;
  readonly lastActivity: number;
}

export interface VaultHandleOptions {
  /** scrypt progress (0..1) for create and unlock. */
  readonly onProgress?: (progress: number) => void;
}

export interface VaultHandler {
  /** Handles one request; requests run strictly one after another. */
  handle(request: unknown, options?: VaultHandleOptions): Promise<VaultResultMap[VaultRequestType]>;
  /** Locks if idle for longer than the auto-lock time and not armed. Returns true if it locked. */
  checkAutoLock(): boolean;
  /** For tests only. */
  inspect(): VaultState;
}

function badRequest(): never {
  throw new AppError('INTERNAL_ERROR');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : badRequest();
}

function int(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : badRequest();
}

function parseSettings(value: unknown): FleetSettingsV1 {
  if (!isRecord(value) || !Array.isArray(value.maxSpend)) return badRequest();
  const items: unknown[] = value.maxSpend;
  return {
    maxSpend: items.map((item) => {
      if (!isRecord(item) || typeof item.lamports !== 'bigint') return badRequest();
      return { index: int(item.index), lamports: item.lamports };
    }),
  };
}

function parseApiKeys(value: unknown): ApiKeysV1 {
  if (!isRecord(value)) return badRequest();
  const keys: { helius?: string; jupiter?: string } = {};
  if (value.helius !== undefined) keys.helius = str(value.helius);
  if (value.jupiter !== undefined) keys.jupiter = str(value.jupiter);
  return keys;
}

function wipeVault(vault: UnlockedVault): void {
  wipe(vault.mnemonic);
  for (const w of vault.wallets) wipe(w.secretKey);
}

/** Converts decrypted secrets into wipeable buffers. The source strings cannot be wiped. */
function toUnlocked(opened: OpenedKeystore): UnlockedVault {
  return {
    fleetName: opened.file.fleetName,
    createdAt: new Date(opened.file.createdAt),
    mnemonic: new TextEncoder().encode(opened.secrets.mnemonic),
    wallets: opened.secrets.wallets.map((w) => ({
      index: w.index,
      secretKey: base58.decode(w.secretKey),
    })),
    publicWallets: opened.file.public.wallets,
    settings: opened.secrets.settings,
    apiKeys: opened.secrets.apiKeys,
    session: opened.session,
  };
}

function toSecrets(
  vault: UnlockedVault,
  wallets: readonly SecretWallet[],
  settings: FleetSettingsV1,
  apiKeys: ApiKeysV1,
): KeystoreSecretsV1 {
  return {
    mnemonic: new TextDecoder().decode(vault.mnemonic),
    wallets: wallets.map((w) => ({ index: w.index, secretKey: secretKeyToBase58(w.secretKey) })),
    settings,
    apiKeys,
  };
}

function infoOf(vault: UnlockedVault): VaultInfo {
  return {
    fleetName: vault.fleetName,
    createdAt: vault.createdAt.toISOString(),
    wallets: vault.publicWallets,
    settings: vault.settings,
    apiKeys: vault.apiKeys,
  };
}

export function createVaultHandler(options: VaultOptions = {}): VaultHandler {
  const now = options.now ?? (() => Date.now());
  const autoLockMs = options.autoLockMs ?? DEFAULT_AUTO_LOCK_MS;
  let unlocked: UnlockedVault | null = null;
  let armed = false;
  let lastActivity = now();
  let tail: Promise<unknown> = Promise.resolve();

  const touch = (): void => {
    lastActivity = now();
  };

  const lock = (): void => {
    if (unlocked) wipeVault(unlocked);
    unlocked = null;
  };

  const install = (opened: OpenedKeystore): void => {
    const next = toUnlocked(opened);
    lock();
    unlocked = next;
  };

  const status = (): VaultStatus => ({
    locked: unlocked === null,
    armed,
    info: unlocked ? infoOf(unlocked) : null,
  });

  const requireUnlocked = (): UnlockedVault => {
    if (unlocked === null) throw new AppError('VAULT_LOCKED');
    return unlocked;
  };

  /** Re-encrypts with the session key and commits the new state only on success. */
  const rebuild = async (
    vault: UnlockedVault,
    wallets: SecretWallet[],
    settings: FleetSettingsV1,
    apiKeys: ApiKeysV1,
  ): Promise<VaultFileResult> => {
    const labels = new Map(vault.publicWallets.map((w) => [w.index, w.label]));
    const file = await buildKeystoreWithSession(
      toSecrets(vault, wallets, settings, apiKeys),
      { fleetName: vault.fleetName, createdAt: vault.createdAt, labels },
      vault.session,
    );
    if (unlocked !== vault) throw new AppError('VAULT_LOCKED');
    const next: UnlockedVault = {
      ...vault,
      wallets,
      publicWallets: file.public.wallets,
      settings,
      apiKeys,
    };
    unlocked = next;
    return { fileText: serializeKeystoreFile(file), info: infoOf(next) };
  };

  const checkAutoLock = (): boolean => {
    if (unlocked !== null && !armed && now() - lastActivity >= autoLockMs) {
      lock();
      return true;
    }
    return false;
  };

  const dispatch = async (
    raw: unknown,
    options: VaultHandleOptions,
  ): Promise<VaultResultMap[VaultRequestType]> => {
    const progress = options.onProgress ? { onProgress: options.onProgress } : {};
    if (!isRecord(raw)) return badRequest();
    const request = raw as VaultRequest;
    checkAutoLock();
    // Reading the status or previewing a file is not user activity on the fleet.
    if (request.type !== 'status' && request.type !== 'preview') touch();

    switch (request.type) {
      case 'create': {
        const opened = await createKeystore({
          fleetName: str(request.fleetName),
          walletCount: int(request.walletCount),
          password: str(request.password),
          ...(request.mnemonic === undefined ? {} : { mnemonic: str(request.mnemonic) }),
          ...progress,
        });
        install(opened);
        touch();
        return {
          fileText: serializeKeystoreFile(opened.file),
          info: infoOf(requireUnlocked()),
        };
      }
      case 'preview': {
        const file = parseKeystoreFile(str(request.fileText));
        return {
          fleetName: file.fleetName,
          createdAt: file.createdAt,
          wallets: file.public.wallets,
        };
      }
      case 'unlock': {
        const fileText = str(request.fileText);
        const password = str(request.password);
        install(await openKeystore(parseKeystoreFile(fileText), password, progress));
        touch();
        return status();
      }
      case 'lock':
        lock();
        return status();
      case 'status':
        return status();
      case 'saveSettings': {
        const vault = requireUnlocked();
        return rebuild(
          vault,
          vault.wallets,
          parseSettings(request.settings),
          parseApiKeys(request.apiKeys),
        );
      }
      case 'addWallets': {
        const vault = requireUnlocked();
        const count = int(request.count);
        const fromIndex = Math.max(...vault.wallets.map((w) => w.index)) + 1;
        if (count < 1 || fromIndex + count > MAX_FLEET_SIZE) {
          throw new AppError('INVALID_DERIVATION_INDEX');
        }
        const derived = deriveWallets(new TextDecoder().decode(vault.mnemonic), fromIndex, count);
        const added = derived.map((d) => ({ index: d.index, secretKey: d.secretKey }));
        try {
          return await rebuild(vault, [...vault.wallets, ...added], vault.settings, vault.apiKeys);
        } catch (e) {
          for (const w of added) wipe(w.secretKey);
          throw e;
        }
      }
      case 'setArmed':
        if (typeof request.armed !== 'boolean') return badRequest();
        armed = request.armed;
        return status();
      case 'activity':
        return status();
      default:
        return badRequest();
    }
  };

  return {
    handle(request: unknown, options: VaultHandleOptions = {}) {
      const run = tail.then(() => dispatch(request, options));
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    checkAutoLock,
    inspect: () => ({ unlocked, armed, lastActivity }),
  };
}

/** Connects a handler to a message port (the worker's `self`, or a MessagePort in tests). */
export function attachVaultHandler(port: VaultPort, handler: VaultHandler): void {
  port.addEventListener('message', (event) => {
    const data = event.data;
    if (!isRecord(data) || typeof data.id !== 'number') return;
    const id = data.id;
    // Report progress in whole percent so a long scrypt does not flood the port.
    let lastPercent = -1;
    const onProgress = (p: number): void => {
      const percent = Math.floor(p * 100);
      if (percent === lastPercent) return;
      lastPercent = percent;
      const message: VaultProgressEnvelope = { id, progress: percent / 100 };
      port.postMessage(message);
    };
    handler.handle(data.request, { onProgress }).then(
      (result) => {
        const reply: VaultResponseEnvelope = { id, ok: true, result };
        port.postMessage(reply);
      },
      (e: unknown) => {
        // Only the code crosses the boundary; unknown errors become INTERNAL_ERROR (D-008).
        const reply: VaultResponseEnvelope = {
          id,
          ok: false,
          code: isAppError(e) ? e.code : 'INTERNAL_ERROR',
        };
        port.postMessage(reply);
      },
    );
  });
}
