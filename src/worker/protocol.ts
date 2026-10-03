/**
 * Message protocol between the UI thread and the vault worker (BUNNDLY-7).
 *
 * Only domain operations exist. There is deliberately no request to sign arbitrary
 * bytes or to export keys without the password (DECISIONS D-013). Responses carry
 * the encrypted file text and public data only; errors carry only a code (D-008).
 */
import type { ExecutorEvent } from '../executor/executor.ts';
import type { WatchEvent, WatchStatus } from '../watcher/watch.ts';
import type {
  ApiKeyName,
  ConnectionReport,
  ErrorCode,
  FleetSettingsV1,
  PlainExport,
  PublicWalletV1,
} from '../core/index.ts';

/**
 * Change of the write-only API secrets (D-016): a missing field keeps the stored value,
 * `null` removes it and a string replaces it.
 */
export type ApiKeyChanges = { readonly [K in ApiKeyName]?: string | null };

/** Which API secrets are set. The values themselves never leave the worker (D-016). */
export type ApiKeyFlags = { readonly [K in ApiKeyName]: boolean };

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
  /** Validates a keystore file and returns its public part; needs no password. */
  | { readonly type: 'preview'; readonly fileText: string }
  | { readonly type: 'unlock'; readonly fileText: string; readonly password: string }
  /** SOL balances of the fleet via Helius (fallback: public RPC). Not user activity. */
  | {
      readonly type: 'refreshBalances';
      /** Also read this token's balance for every wallet (SPL Token or Token-2022). */
      readonly mint?: string;
    }
  /**
   * Connection test (SPEC 3.3): Helius HTTP and WSS, Jupiter quote without `taker`. Runs
   * with the saved keys; the answer has statuses and times only, never a key (D-024).
   */
  | { readonly type: 'testConnections' }
  | { readonly type: 'lock' }
  | { readonly type: 'status' }
  | {
      readonly type: 'saveSettings';
      /** Replaces all settings (global, maxSpend, active). */
      readonly settings: FleetSettingsV1;
      readonly apiKeys?: ApiKeyChanges;
    }
  | { readonly type: 'addWallets'; readonly count: number }
  /**
   * Plain export of the mnemonic and private keys (SPEC 3.1, D-023). The password is
   * checked by a full scrypt derivation and decryption, never compared with anything
   * kept in memory. The only request whose answer contains secrets.
   */
  | {
      readonly type: 'exportPlain';
      readonly password: string;
      readonly format: 'txt' | 'json';
    }
  /**
   * Buy `mint` with every active wallet that has a max spend (SPEC 3.4 A, BUNNDLY-21).
   * Runs in the worker; progress arrives as events. DRY-RUN unless the settings say
   * otherwise. While it runs the vault is armed: no auto-lock and no manual lock.
   */
  | { readonly type: 'startBuy'; readonly mint: string }
  /** STOP: no new `/order`; transactions already sent are followed to the end. */
  | { readonly type: 'stop' }
  /**
   * Mode B (SPEC 3.4 B, BUNNDLY-34): watch `creator` and buy every token it creates, by
   * the `mode` setting. While armed: no auto-lock and no manual lock.
   */
  | { readonly type: 'arm'; readonly creator: string }
  /** Closes the socket and empties the detection queue; a running buy goes on. */
  | { readonly type: 'disarm' }
  /** User activity in the UI; resets the auto-lock timer. */
  | { readonly type: 'activity' };

export type VaultRequestType = VaultRequest['type'];

/** Public view of an unlocked fleet. Never contains the mnemonic or private keys. */
export interface VaultInfo {
  readonly fleetName: string;
  readonly createdAt: string;
  readonly wallets: readonly PublicWalletV1[];
  readonly settings: FleetSettingsV1;
  readonly apiKeys: ApiKeyFlags;
}

/**
 * Public part of a keystore file read without the password. The addresses are NOT
 * verified: only unlocking checks them against the encrypted keys (D-018).
 */
export interface VaultPreview {
  readonly fleetName: string;
  readonly createdAt: string;
  readonly wallets: readonly PublicWalletV1[];
}

export interface WalletBalance {
  readonly index: number;
  readonly lamports: bigint;
}

export interface WalletTokenBalance {
  readonly index: number;
  /** Raw amount (u64); divide by 10^decimals for display. */
  readonly amount: bigint;
}

export interface VaultTokenBalances {
  readonly mint: string;
  readonly program: 'spl-token' | 'token-2022';
  readonly decimals: number;
  readonly balances: readonly WalletTokenBalance[];
}

export interface VaultBalances {
  readonly balances: readonly WalletBalance[];
  /** Present when the request named a mint. */
  readonly token?: VaultTokenBalances;
  /** `fallback`: Helius failed and the public RPC answered (shown in the UI). */
  readonly source: 'helius' | 'fallback';
  /** ISO-8601 time of the read. */
  readonly fetchedAt: string;
}

export interface BuyStatus {
  readonly runId: number;
  readonly mint: string;
  readonly dryRun: boolean;
  /** Wallets taking part (active, with a max spend). */
  readonly wallets: number;
  /** False after STOP, while sent transactions finish. */
  readonly accepting: boolean;
}

export interface VaultStatus {
  readonly locked: boolean;
  /** A buy is running or the watcher is armed (auto-lock and lock suspended). */
  readonly armed: boolean;
  readonly info: VaultInfo | null;
  /** The running buy, if any. */
  readonly buy: BuyStatus | null;
  /** The last arming of this session (mode B), also after it disarmed; null if none. */
  readonly watch: WatchStatus | null;
}

/** Encrypted keystore file text to save, plus the new public view. */
export interface VaultFileResult {
  readonly fileText: string;
  readonly info: VaultInfo;
}

export interface VaultResultMap {
  readonly create: VaultFileResult;
  readonly preview: VaultPreview;
  readonly refreshBalances: VaultBalances;
  readonly testConnections: ConnectionReport;
  readonly exportPlain: PlainExport;
  readonly unlock: VaultStatus;
  readonly lock: VaultStatus;
  readonly status: VaultStatus;
  readonly saveSettings: VaultFileResult;
  readonly addWallets: VaultFileResult;
  readonly startBuy: BuyStatus;
  readonly stop: VaultStatus;
  readonly arm: VaultStatus;
  readonly disarm: VaultStatus;
  readonly activity: VaultStatus;
}

export type VaultRequestOf<T extends VaultRequestType> = Extract<VaultRequest, { type: T }>;

export interface VaultRequestEnvelope {
  readonly id: number;
  readonly request: VaultRequest;
}

/** Progress of a long request (scrypt in create/unlock), 0..1, sent before the response. */
export interface VaultProgressEnvelope {
  readonly id: number;
  readonly progress: number;
}

/** Everything the worker pushes on its own: executor progress and the watcher (mode B). */
export type WorkerEvent = ExecutorEvent | WatchEvent;

/**
 * Executor and watcher progress, pushed by the worker without a request id (BUNNDLY-21,
 * BUNNDLY-34). Carries no keys, no signed transactions and no URLs.
 */
export interface VaultEventEnvelope {
  readonly event: WorkerEvent;
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
