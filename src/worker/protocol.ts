/**
 * Message protocol between the UI thread and the vault worker (BUNNDLY-7).
 *
 * Only domain operations exist. There is deliberately no request to sign arbitrary
 * bytes or to export keys without the password (DECISIONS D-013). Responses carry
 * the encrypted file text and public data only; errors carry only a code (D-008).
 */
import type { FeedState } from '../chain/balance-stream.ts';
import type { TargetKind } from '../chain/target.ts';
import type { ExecutorEvent, Side, StairsOptions } from '../executor/executor.ts';
import type { WatchEvent, WatchStatus } from '../watcher/watch.ts';
import type { BackupDirectory, BackupView } from './backup.ts';
import type { RememberedView } from './remember.ts';

export type { BackupDirectory, BackupState, BackupView } from './backup.ts';

export type { RememberedView, RememberPrefs } from './remember.ts';

/** The open fleet's newest file, not yet on disk (BUNNDLY-80). Encrypted, as written to disk. */
export interface PendingFile {
  readonly fileText: string;
  readonly fleetName: string;
}
import type {
  ApiKeyName,
  ConnectionReport,
  ErrorCode,
  FleetSettingsV1,
  Network,
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

export type VaultRequest =
  | {
      readonly type: 'create';
      readonly fleetName: string;
      readonly walletCount: number;
      readonly password: string;
      /** Import an existing mnemonic; omit to generate a new 24-word one. */
      readonly mnemonic?: string;
      /** Remember the fleet on this device (BUNNDLY-52); omitted leaves the device as it is. */
      readonly remember?: boolean;
    }
  /** Validates a keystore file and returns its public part; needs no password. */
  | { readonly type: 'preview'; readonly fileText: string }
  | {
      readonly type: 'unlock';
      readonly fileText: string;
      readonly password: string;
      /** As in `create`. */
      readonly remember?: boolean;
    }
  /** The fleet remembered on this device and the device settings (public data only). */
  | { readonly type: 'remembered' }
  /**
   * Opens the remembered fleet without the password while its window lasts (BUNNDLY-52)
   * and starts the window again from now. Otherwise, or on any problem, removes the
   * session record and answers the locked status.
   */
  | { readonly type: 'resume' }
  /** Unlocks the remembered fleet with the password. */
  | { readonly type: 'unlockRemembered'; readonly password: string }
  /** Device settings: remember the fleet, and the window length (null: no time limit). */
  | {
      readonly type: 'setRemember';
      readonly remember: boolean;
      readonly windowMs: number | null;
    }
  /** "Forget this device": removes the remembered fleet and the session record. */
  | { readonly type: 'forget' }
  /**
   * The open fleet's file when the one on disk is older (BUNNDLY-80): created or changed
   * and not written since. Null when the newest file was written or opened from disk.
   */
  | { readonly type: 'pendingFile' }
  /** The UI wrote `fileText` to disk; only the newest file clears the pending one. */
  | { readonly type: 'fileSaved'; readonly fileText: string }
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
      /**
       * Replaces global, maxSpend and active; the trade parameters (BUNNDLY-58) and the
       * wallet groups (BUNNDLY-68) too when present, otherwise they stay as they are.
       */
      readonly settings: Omit<
        FleetSettingsV1,
        'trade' | 'groups' | 'resetFields' | 'resetTradeFields' | 'resetGroups'
      > & {
        readonly trade?: FleetSettingsV1['trade'];
        readonly groups?: FleetSettingsV1['groups'];
      };
      readonly apiKeys?: ApiKeyChanges;
    }
  /**
   * Mainnet or devnet for the open fleet (BUNNDLY-44). Saved with the settings: the answer
   * is the new file text. Refused while a buy runs or the watcher is armed.
   */
  | { readonly type: 'setNetwork'; readonly network: Network }
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
   * What a pasted address is (BUNNDLY-59): a token mint or a wallet. Token accounts,
   * programs and other accounts are refused with a code that names them.
   */
  | { readonly type: 'classifyTarget'; readonly address: string }
  /**
   * Buy `mint` with the group's wallets that have a buy amount (SPEC 3.4 A, BUNNDLY-21).
   * With `wallets` (BUNNDLY-59) the listed wallets buy, all of them in the group, and the
   * saved selection plays no part; without it the group's active wallets buy. The worker
   * checks first that `mint` is a token mint. Runs in the worker; progress arrives as
   * events. DRY-RUN unless the settings say otherwise. While it runs the vault is armed:
   * no auto-lock and no manual lock.
   */
  | {
      readonly type: 'startBuy';
      readonly mint: string;
      /** Wallet indices; each at most once, all in the group. */
      readonly wallets?: readonly number[];
      readonly group?: string;
      /** Stairs mode (BUNNDLY-61); absent: Immediate. */
      readonly stairs?: StairsOptions;
    }
  /**
   * Sell `mint` for SOL with the listed wallets (SPEC 11.4, BUNNDLY-60). The token balances
   * are read first; each wallet sells `floor(balance × percent / 100)` of that read and
   * never more. The same run as a buy: DRY-RUN unless the settings say otherwise, armed
   * while it runs, `stop` stops it, and no buy or other sell starts meanwhile.
   */
  | {
      readonly type: 'startSell';
      readonly mint: string;
      /** Wallet indices; each at most once. */
      readonly wallets: readonly number[];
      /** Part of the token balance to sell: an integer 1-100. 100 when omitted. */
      readonly percent?: number;
      /** The wallets must all be in this group. */
      readonly group?: string;
      /** Stairs mode (BUNNDLY-61); absent: Immediate. */
      readonly stairs?: StairsOptions;
    }
  /** STOP: no new `/order`; transactions already sent are followed to the end. */
  | { readonly type: 'stop'; readonly group?: string }
  /**
   * Stairs (BUNNDLY-61): no new step and no new `/order` until `resumeStairs`; sent transactions
   * finish. Without a Stairs run, or once every step has started, nothing changes.
   */
  | { readonly type: 'pauseStairs'; readonly group?: string }
  /** Stairs: the steps left start later by the time paused. */
  | { readonly type: 'resumeStairs'; readonly group?: string }
  /**
   * Mode B (SPEC 3.4 B, BUNNDLY-34): watch `creator` and buy every token it creates, by
   * the `mode` setting. `wallets` as in startBuy, fixed until disarmed (BUNNDLY-59); the
   * worker checks first that `creator` is a wallet. While armed: no auto-lock and no
   * manual lock.
   */
  | {
      readonly type: 'arm';
      readonly creator: string;
      readonly wallets?: readonly number[];
      readonly group?: string;
      /** Stairs mode for every buy of this arming (BUNNDLY-61); steps count from the detection. */
      readonly stairs?: StairsOptions;
    }
  /** Closes the socket and empties the detection queue; a running buy goes on. */
  | { readonly type: 'disarm'; readonly group?: string }
  /** User activity in the UI; resets the auto-lock timer. */
  | { readonly type: 'activity' }
  /**
   * Live balances (BUNNDLY-57, D-055): `on` opens one Helius WebSocket with a subscription
   * per wallet, `off` closes it. Changes arrive as `balance` events. Locking closes it too.
   * Not user activity. Without a Helius key the feed stays `polling`.
   */
  | { readonly type: 'balanceFeed'; readonly on: boolean }
  /** The backup folder of the open fleet (BUNNDLY-62): state and wallets without a backup. */
  | { readonly type: 'backupStatus' }
  /**
   * Turns the backup folder on for the open fleet: the password is checked by a full
   * derivation, as for the plain export, then the files are written at once.
   */
  | {
      readonly type: 'enableBackup';
      readonly handle: BackupDirectory;
      readonly password: string;
    }
  /** The folder's handle, for the page to ask the browser for access with a click. */
  | { readonly type: 'backupHandle' }
  /** The page got the access back: write now. */
  | { readonly type: 'backupRetry' }
  | { readonly type: 'disableBackup' };

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
  /** The network the balances were read on. */
  readonly network: Network;
  readonly balances: readonly WalletBalance[];
  /** Present when the request named a mint. */
  readonly token?: VaultTokenBalances;
  /** `fallback`: Helius failed and the public RPC answered (shown in the UI). */
  readonly source: 'helius' | 'fallback';
  /**
   * The lowest `context.slot` of the SOL balance batches (BUNNDLY-91); absent when no
   * account was read. Never filled in from elsewhere.
   */
  readonly slot?: number;
  /** ISO-8601 time of the read. */
  readonly fetchedAt: string;
}

/** Where the balances on screen come from now (BUNNDLY-57). */
export interface BalanceFeedStatus {
  readonly network: Network;
  readonly state: FeedState;
}

/**
 * Live balance changes (BUNNDLY-57, D-055), each with the network it was read on: the UI
 * drops one that belongs to a network no longer shown.
 */
export type BalanceEvent = { readonly kind: 'balance'; readonly network: Network } & (
  | { readonly type: 'feed'; readonly state: FeedState }
  /** A wallet's SOL balance from its account subscription. */
  | { readonly type: 'sol'; readonly index: number; readonly lamports: bigint }
  /** A wallet's token balance, read right after its transaction landed. */
  | {
      readonly type: 'token';
      readonly mint: string;
      readonly index: number;
      readonly amount: bigint;
    }
);

export interface BuyStatus {
  /** Present for a sell only. */
  readonly side?: Side;
  readonly runId: number;
  readonly mint: string;
  readonly dryRun: boolean;
  /** Wallets taking part (a buy: active, with a max spend; a sell: the listed ones). */
  readonly wallets: number;
  /** False after STOP, while sent transactions finish. */
  readonly accepting: boolean;
  /** Present for a Stairs run only (BUNNDLY-61). */
  readonly stairs?: StairsOptions;
  /** Stairs: paused with `pauseStairs`. */
  readonly paused?: boolean;
}

/** One wallet group's state (BUNNDLY-68). */
export interface GroupStatus {
  readonly id: string;
  /** The group buys, sells or its watcher is armed. */
  readonly armed: boolean;
  readonly buy: BuyStatus | null;
  /** The group's last arming, also after it disarmed; null if none. */
  readonly watch: WatchStatus | null;
}

export interface VaultStatus {
  readonly locked: boolean;
  /** The open fleet's network; mainnet while locked (nothing is read then). */
  readonly network: Network;
  /** A buy is running or the watcher is armed (auto-lock and lock suspended). */
  readonly armed: boolean;
  readonly info: VaultInfo | null;
  /** The running buy, if any. */
  readonly buy: BuyStatus | null;
  /** The last arming of this session (mode B), also after it disarmed; null if none. */
  readonly watch: WatchStatus | null;
  /** Every group of the open fleet, in order; empty while locked (BUNNDLY-68). */
  readonly groups: readonly GroupStatus[];
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
  readonly classifyTarget: TargetKind;
  readonly exportPlain: PlainExport;
  readonly unlock: VaultStatus;
  readonly remembered: RememberedView;
  readonly resume: VaultStatus;
  readonly unlockRemembered: VaultStatus;
  readonly setRemember: RememberedView;
  readonly forget: RememberedView;
  readonly pendingFile: PendingFile | null;
  readonly fileSaved: PendingFile | null;
  readonly lock: VaultStatus;
  readonly status: VaultStatus;
  readonly saveSettings: VaultFileResult;
  readonly setNetwork: VaultFileResult;
  readonly addWallets: VaultFileResult;
  readonly startBuy: BuyStatus;
  readonly startSell: BuyStatus;
  readonly stop: VaultStatus;
  readonly pauseStairs: VaultStatus;
  readonly resumeStairs: VaultStatus;
  readonly arm: VaultStatus;
  readonly disarm: VaultStatus;
  readonly activity: VaultStatus;
  readonly balanceFeed: BalanceFeedStatus;
  readonly backupStatus: BackupView;
  readonly enableBackup: BackupView;
  readonly backupHandle: BackupDirectory | null;
  readonly backupRetry: BackupView;
  readonly disableBackup: BackupView;
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

/**
 * Everything the worker pushes on its own: executor progress, the watcher, live balances,
 * the backup folder.
 */
export type WorkerEvent = ExecutorEvent | WatchEvent | BalanceEvent | BackupEvent;

/** The backup folder's state changed (BUNNDLY-62): no file content, no handle. */
export interface BackupEvent {
  readonly kind: 'backup';
  readonly view: BackupView;
}

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
