/**
 * Message protocol between the UI thread and the vault worker (BUNNDLY-7).
 *
 * Only domain operations exist. There is deliberately no request to sign arbitrary
 * bytes or to export keys without the password (DECISIONS D-013). Responses carry
 * the encrypted file text and public data only; errors carry only a code (D-008).
 */
import type { ApiKeysV1, ErrorCode, FleetSettingsV1, PublicWalletV1 } from '../core/index.ts';

/** Default inactivity before the vault locks itself (SPEC 3.1: 15 minutes). */
export const DEFAULT_AUTO_LOCK_MS = 15 * 60 * 1000;

export type VaultRequest =
  | {
      readonly type: 'create';
      readonly fleetName: string;
      readonly walletCount: number;
      readonly password: string;
      /** Import an existing mnemonic; omit to generate a new 24-word one. */
      readonly mnemonic?: string;
    }
  | { readonly type: 'unlock'; readonly fileText: string; readonly password: string }
  | { readonly type: 'lock' }
  | { readonly type: 'status' }
  | {
      readonly type: 'saveSettings';
      readonly settings: FleetSettingsV1;
      readonly apiKeys: ApiKeysV1;
    }
  | { readonly type: 'addWallets'; readonly count: number }
  /** While armed (watcher/executor running) auto-lock is suspended. */
  | { readonly type: 'setArmed'; readonly armed: boolean }
  /** User activity in the UI; resets the auto-lock timer. */
  | { readonly type: 'activity' };

export type VaultRequestType = VaultRequest['type'];

/** Public view of an unlocked fleet. Never contains the mnemonic or private keys. */
export interface VaultInfo {
  readonly fleetName: string;
  readonly createdAt: string;
  readonly wallets: readonly PublicWalletV1[];
  readonly settings: FleetSettingsV1;
  readonly apiKeys: ApiKeysV1;
}

export interface VaultStatus {
  readonly locked: boolean;
  readonly armed: boolean;
  readonly info: VaultInfo | null;
}

/** Encrypted keystore file text to save, plus the new public view. */
export interface VaultFileResult {
  readonly fileText: string;
  readonly info: VaultInfo;
}

export interface VaultResultMap {
  readonly create: VaultFileResult;
  readonly unlock: VaultStatus;
  readonly lock: VaultStatus;
  readonly status: VaultStatus;
  readonly saveSettings: VaultFileResult;
  readonly addWallets: VaultFileResult;
  readonly setArmed: VaultStatus;
  readonly activity: VaultStatus;
}

export type VaultRequestOf<T extends VaultRequestType> = Extract<VaultRequest, { type: T }>;

export interface VaultRequestEnvelope {
  readonly id: number;
  readonly request: VaultRequest;
}

export type VaultResponseEnvelope =
  | { readonly id: number; readonly ok: true; readonly result: VaultResultMap[VaultRequestType] }
  | { readonly id: number; readonly ok: false; readonly code: ErrorCode };

/** Minimal message port shared by Worker, worker `self` and MessagePort (and test fakes). */
export interface VaultPort {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
  /**
   * Called when the worker itself fails (`error` / `messageerror` on the Worker), so the
   * client can reject pending requests at once instead of waiting for their timeouts.
   */
  addFailureListener?(listener: () => void): void;
}
