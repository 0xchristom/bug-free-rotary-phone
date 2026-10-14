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
import type { RpcTransport } from '@solana/kit';
import {
  createBalancesRpc,
  createHttpTransport,
  createLandingChecker,
  createLandingRpc,
  createResilientTransport,
  createWatchRpc,
  signatureReader,
  transactionReader,
  fetchSolBalances,
  checkHeliusHttp,
  checkHeliusWs,
  fetchTokenBalances,
  type RpcSource,
  type WebSocketFactory,
} from '../chain/index.ts';
import {
  startRun,
  type ExecutorEvent,
  type ExecutorRun,
  type ExecutorWallet,
  type Side,
} from '../executor/executor.ts';
import { fetchTarget, parseTargetAddress, type TargetKind } from '../chain/target.ts';
import { isSellPercent, sellAmount } from '../executor/sell-plan.ts';
import { percentBuyAmount } from '../executor/buy-plan.ts';
import { startWatch, type BuyTrigger, type Watch } from '../watcher/watch.ts';
import type { LandingChecker } from '../executor/landing.ts';
import { createVerifier, type SolReader, type TokenReader } from '../executor/verify.ts';
import { ExecuteLimiter, OrderLimiter, realClock, type LimiterClock } from '../executor/limiter.ts';
import { checkOrderTransaction, type OrderCheckProblem } from '../executor/order-check.ts';
import {
  SOL_MINT,
  checkJupiterQuote,
  createJupiterClient,
  type JupiterClient,
  type JupiterOrder,
} from '../jupiter/index.ts';
import { signCheckedOrder, type SignedOrder } from './sign-order.ts';
import {
  API_KEY_NAMES,
  AppError,
  MAX_FLEET_SIZE,
  buildKeystoreWithSession,
  buildPlainExport,
  createKeystore,
  deriveWallets,
  isAppError,
  isValidApiKeyValue,
  openKeystore,
  parseKeystoreFile,
  secretKeyToBase58,
  serializeKeystoreFile,
  CONNECTION_TEST_TIMEOUT_MS,
  DEFAULT_NETWORK,
  NETWORKS,
  buyRouteOf,
  endpointNetwork,
  heliusRpcUrl,
  heliusWsUrl,
  publicRpcUrl,
  effectiveJupiterPlan,
  validateGlobalSettings,
  validateGroups,
  validateTradeSettings,
  effectiveGroups,
  groupOf,
  walletTrade,
  wipe,
  withNewWallets,
  type ApiKeyName,
  type BuyAmount,
  type TradeSettingsV1,
  type WalletTradeV1,
  type ApiKeysV1,
  type ConnectionReport,
  type FetchLike,
  type FleetSettingsV1,
  type GlobalSettingsV1,
  type KeystoreSecretsV1,
  type KeystoreSession,
  type Network,
  type OpenedKeystore,
  type PublicWalletV1,
  type WalletGroupV1,
} from '../core/index.ts';
import { DEFAULT_AUTO_LOCK_MS } from './protocol.ts';
import type {
  ApiKeyFlags,
  BuyStatus,
  VaultBalances,
  VaultEventEnvelope,
  VaultFileResult,
  VaultInfo,
  VaultPort,
  VaultProgressEnvelope,
  VaultRequest,
  VaultRequestOf,
  VaultRequestType,
  VaultResponseEnvelope,
  VaultResultMap,
  VaultStatus,
  WorkerEvent,
} from './protocol.ts';

export { DEFAULT_AUTO_LOCK_MS } from './protocol.ts';

export interface ChainOptions {
  /** HTTP transport per URL; tests pass a mock. */
  readonly createTransport?: (url: string) => RpcTransport;
  /** Backoff sleep; tests pass an instant one. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Network access of the connection test; tests pass mocks. */
export interface NetOptions {
  readonly fetch?: FetchLike;
  readonly createWebSocket?: WebSocketFactory;
  readonly timeoutMs?: number;
  /** Monotonic clock in ms for measured times. */
  readonly clock?: () => number;
}

/** Executor dependencies; tests pass a fake Jupiter and clock. */
export interface ExecutorOptions {
  readonly jupiter?: JupiterClient;
  readonly clock?: LimiterClock;
  /** Even `/order` pace instead of a burst (D-027 emergency mode). */
  readonly steady?: boolean;
  /** Chain check before retries; by default over Helius with the public fallback. */
  readonly landing?: LandingChecker;
  /**
   * Token balance reads for the confirmation after a buy or a sell, and for the plan of a
   * sell; by default over Helius.
   */
  readonly tokens?: TokenReader;
  /** SOL balance reads for the confirmation after a sell; by default over Helius. */
  readonly sol?: SolReader;
}

/** Mode B dependencies; the socket comes from `net.createWebSocket`, the clock from `executor`. */
export interface WatchOptions {
  /** High-resolution time for `reactionMs`; `performance.now()` by default. */
  readonly perfNow?: () => number;
  readonly random?: () => number;
  readonly balanceRefreshMs?: number;
}

export interface VaultOptions {
  /** Clock in ms; injectable for tests. */
  readonly now?: () => number;
  readonly chain?: ChainOptions;
  readonly net?: NetOptions;
  readonly executor?: ExecutorOptions;
  readonly watch?: WatchOptions;
  /**
   * Inactivity before auto-lock. Overrides the fleet's `autoLockMinutes` setting (tests);
   * without it the setting applies, and 15 minutes while locked.
   */
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

/** What the executor asked `/order` for, for one wallet (BUNNDLY-22). */
export interface OrderSignRequest {
  /** A sell only: the token sold. The vault signs it only for its own running sell. */
  readonly inputMint?: string;
  readonly outputMint: string;
  /**
   * Input units asked for; must equal the order's inAmount and fit the wallet's limit: its
   * max spend for a buy, its planned token amount for a sell.
   */
  readonly amount: bigint;
}

export type SignOrderResult =
  | ({ readonly ok: true } & SignedOrder)
  | {
      readonly ok: false;
      readonly problem:
        | OrderCheckProblem
        | 'VAULT_LOCKED'
        | 'UNKNOWN_WALLET'
        | 'SIGNING_FAILED'
        /** A sell the vault did not plan: another mint, or no sell running. */
        | 'NO_SELL_PLAN';
    };

export interface VaultHandler {
  /** Handles one request; requests run strictly one after another. */
  handle(request: unknown, options?: VaultHandleOptions): Promise<VaultResultMap[VaultRequestType]>;
  /**
   * For the executor inside the worker only (BUNNDLY-22, D-028); not reachable through
   * `handle` or the message protocol. Signs the `/order` transaction of one wallet after
   * the checks pass; the limit is the vault's own: the max spend from its settings for a
   * buy, the plan it made at `startSell` for a sell. Never throws.
   */
  signOrder(
    walletIndex: number,
    request: OrderSignRequest,
    order: JupiterOrder,
  ): Promise<SignOrderResult>;
  /** Executor and watcher progress (BUNNDLY-21, BUNNDLY-34). Returns the unsubscribe function. */
  onEvent(listener: (event: WorkerEvent) => void): () => void;
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

function invalidSettings(): never {
  throw new AppError('INVALID_SETTINGS');
}

function isIndexIn(value: unknown, indices: ReadonlySet<number>): value is number {
  return typeof value === 'number' && indices.has(value);
}

/**
 * Wallets a buy or an arming names (BUNNDLY-59): every item a wallet of the group, no
 * repeats. Absent: null, the group's saved selection decides. Anything else is malformed.
 */
function walletListOf(value: unknown, group: WalletGroupV1): readonly number[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return badRequest();
  const items: unknown[] = value;
  const members = new Set(group.wallets);
  const seen = new Set<number>();
  for (const item of items) {
    if (!isIndexIn(item, members) || seen.has(item)) return badRequest();
    seen.add(item);
  }
  return [...seen];
}

const SLIPPAGE_KEYS = ['buySlippageBps', 'sellSlippageBps'] as const;
const FEE_KEYS = ['buyPriorityFeeLamports', 'sellPriorityFeeLamports'] as const;

/** A buy amount from the UI: null, or exactly one of the two kinds. */
function buyAmountOf(value: unknown): BuyAmount | null {
  if (value === null) return null;
  if (!isRecord(value)) return invalidSettings();
  if (value.kind === 'percent' && typeof value.percent === 'number') {
    return { kind: 'percent', percent: value.percent };
  }
  if (value.kind === 'lamports' && typeof value.lamports === 'bigint') {
    return { kind: 'lamports', lamports: value.lamports };
  }
  return invalidSettings();
}

/**
 * Trade parameters from the UI (BUNNDLY-58), copied field by field; the ranges are
 * checked with the rest of the settings in `parseSettings`.
 */
function parseTrade(value: unknown, walletIndices: ReadonlySet<number>): TradeSettingsV1 {
  if (!isRecord(value) || !isRecord(value.fleet) || !Array.isArray(value.wallets)) {
    return invalidSettings();
  }
  const f = value.fleet;
  const fleet = {
    buyAmount: buyAmountOf(f.buyAmount),
    sellPercent: f.sellPercent,
    buySlippageBps: f.buySlippageBps,
    sellSlippageBps: f.sellSlippageBps,
    buyPriorityFeeLamports: f.buyPriorityFeeLamports,
    sellPriorityFeeLamports: f.sellPriorityFeeLamports,
  } as TradeSettingsV1['fleet'];
  const items: unknown[] = value.wallets;
  const wallets = items.map((item): WalletTradeV1 => {
    if (!isRecord(item) || !isIndexIn(item.index, walletIndices)) return invalidSettings();
    const entry: Record<string, unknown> = { index: item.index };
    for (const key of ['buyPercent', 'sellPercent', ...SLIPPAGE_KEYS, ...FEE_KEYS]) {
      if (item[key] !== undefined) entry[key] = item[key];
    }
    return entry as unknown as WalletTradeV1;
  });
  if (new Set(wallets.map((w) => w.index)).size !== wallets.length) invalidSettings();
  return { fleet, wallets };
}

/** Wallet groups from a request: the shape here, the rules in validateGroups. */
function parseGroups(value: unknown, walletIndices: ReadonlySet<number>): WalletGroupV1[] {
  if (!Array.isArray(value)) return invalidSettings();
  const items: unknown[] = value;
  const groups = items.map((item): WalletGroupV1 => {
    if (!isRecord(item) || !Array.isArray(item.wallets)) return invalidSettings();
    if (typeof item.id !== 'string' || typeof item.name !== 'string') return invalidSettings();
    const wallets: unknown[] = item.wallets;
    if (!wallets.every((w): w is number => isIndexIn(w, walletIndices))) invalidSettings();
    return { id: item.id, name: item.name, wallets: [...wallets] };
  });
  if (validateGroups(groups, walletIndices).length > 0) invalidSettings();
  return groups;
}

/**
 * Full settings from the UI; anything malformed or out of range is INVALID_SETTINGS.
 * Without `trade` or `groups` the current ones stay.
 */
function parseSettings(
  value: unknown,
  walletIndices: ReadonlySet<number>,
  current: Pick<FleetSettingsV1, 'trade' | 'groups'>,
): FleetSettingsV1 {
  if (!isRecord(value) || !Array.isArray(value.maxSpend) || !Array.isArray(value.active)) {
    return invalidSettings();
  }
  const maxSpendItems: unknown[] = value.maxSpend;
  const activeItems: unknown[] = value.active;
  const maxSpend = maxSpendItems.map((item) => {
    if (
      !isRecord(item) ||
      !isIndexIn(item.index, walletIndices) ||
      typeof item.lamports !== 'bigint' ||
      item.lamports < 0n ||
      item.lamports >= 2n ** 64n
    ) {
      return invalidSettings();
    }
    return { index: item.index, lamports: item.lamports };
  });
  const active = activeItems.map((item) => {
    if (!isRecord(item) || !isIndexIn(item.index, walletIndices)) return invalidSettings();
    if (typeof item.active !== 'boolean') return invalidSettings();
    return { index: item.index, active: item.active };
  });
  for (const list of [maxSpend, active]) {
    if (new Set(list.map((i) => i.index)).size !== list.length) invalidSettings();
  }
  if (!isRecord(value.global)) return invalidSettings();
  const g = value.global;
  const global = {
    minReserveLamports: g.minReserveLamports,
    maxAttempts: g.maxAttempts,
    priceCeilingPercent: g.priceCeilingPercent,
    noRouteWindowMs: g.noRouteWindowMs,
    noRouteBackoffMinMs: g.noRouteBackoffMinMs,
    noRouteBackoffMaxMs: g.noRouteBackoffMaxMs,
    mode: g.mode,
    explorer: g.explorer,
    autoLockMinutes: g.autoLockMinutes,
    jupiterPlan: g.jupiterPlan,
    orderRpm: g.orderRpm,
    dryRun: g.dryRun,
    network: g.network,
  } as FleetSettingsV1['global'];
  if (validateGlobalSettings(global).length > 0) return invalidSettings();
  const trade = value.trade === undefined ? current.trade : parseTrade(value.trade, walletIndices);
  // Checked against this request's maxSpend: a SOL amount and a percent never both.
  const withSol = new Set(maxSpend.filter((m) => m.lamports > 0n).map((m) => m.index));
  if (validateTradeSettings(trade, walletIndices, withSol).length > 0) return invalidSettings();
  const groups =
    value.groups === undefined ? current.groups : parseGroups(value.groups, walletIndices);
  return { maxSpend, active, global, trade, groups };
}

/** Applies write-only key changes: missing keeps, null removes, a string replaces. */
function applyKeyChanges(current: ApiKeysV1, changes: unknown): ApiKeysV1 {
  if (changes === undefined) return current;
  if (!isRecord(changes)) return invalidSettings();
  if (!Object.keys(changes).every((k) => (API_KEY_NAMES as readonly string[]).includes(k))) {
    return invalidSettings();
  }
  const next: { -readonly [K in ApiKeyName]?: string } = {};
  for (const name of API_KEY_NAMES) {
    const change = changes[name];
    let value: string | undefined;
    if (change === undefined) value = current[name];
    else if (change === null) value = undefined;
    else if (typeof change === 'string' && isValidApiKeyValue(name, change)) value = change;
    else return invalidSettings();
    if (value !== undefined) next[name] = value;
  }
  return next;
}

function keyFlags(keys: ApiKeysV1): ApiKeyFlags {
  return {
    helius: keys.helius !== undefined,
    jupiter: keys.jupiter !== undefined,
    heliusRpcUrl: keys.heliusRpcUrl !== undefined,
    heliusWsUrl: keys.heliusWsUrl !== undefined,
  };
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
    apiKeys: keyFlags(vault.apiKeys),
  };
}

export function createVaultHandler(options: VaultOptions = {}): VaultHandler {
  const now = options.now ?? (() => Date.now());
  const autoLockMs = (): number =>
    options.autoLockMs ??
    (unlocked ? unlocked.settings.global.autoLockMinutes * 60_000 : DEFAULT_AUTO_LOCK_MS);
  let unlocked: UnlockedVault | null = null;
  /** Changes on every unlock and lock; settings changes keep it (unlike `unlocked`). */
  let session = 0;
  /** SOL balances from the last refresh of this session (pre-check before `/order`). */
  let balances = new Map<number, bigint>();
  /** What one wallet group (BUNNDLY-68) is doing; groups run independently. */
  interface GroupRun {
    buy: { readonly run: ExecutorRun; status: BuyStatus } | null;
    /**
     * The group's running buy or sell: its mint and what each wallet may put in, fixed at
     * its start (a sell: from the balance read then, BUNNDLY-60; a buy: the SOL amount or
     * the percent of the balance, BUNNDLY-58). The signer checks every order against it.
     */
    runPlan: {
      readonly side: Side;
      readonly mint: string;
      readonly amounts: ReadonlyMap<number, bigint>;
    } | null;
    /** The group's last arming (mode B); kept after it disarms, for its status. */
    watch: Watch | null;
  }
  /** By group id; a group without an entry has never run in this session. */
  let groupRuns = new Map<string, GroupRun>();
  /** `network:address` this session read as token mints: a mint never changes its kind. */
  let knownMints = new Map<string, TargetKind>();
  const runOf = (id: string): GroupRun => {
    let run = groupRuns.get(id);
    if (run === undefined) {
      run = { buy: null, runPlan: null, watch: null };
      groupRuns.set(id, run);
    }
    return run;
  };
  const allRuns = (): GroupRun[] => [...groupRuns.values()];
  const watchActive = (run: GroupRun): boolean => run.watch?.active() ?? false;
  const groupBusy = (run: GroupRun): boolean => run.buy !== null || watchActive(run);
  const anyBuy = (): boolean => allRuns().some((r) => r.buy !== null);
  const anyWatch = (): boolean => allRuns().some(watchActive);
  let nextRunId = 1;
  const listeners = new Set<(event: WorkerEvent) => void>();
  /** Limiters live across runs, so a new buy respects the window of the last one. */
  const limiters = new Map<string, { order: OrderLimiter; execute: ExecuteLimiter }>();
  /** Some group buys, sells or watches: no auto-lock, no lock, no other fleet. */
  const isArmed = (): boolean => allRuns().some(groupBusy);
  let lastActivity = now();
  let tail: Promise<unknown> = Promise.resolve();

  const touch = (): void => {
    lastActivity = now();
  };

  const lock = (): void => {
    if (unlocked) wipeVault(unlocked);
    unlocked = null;
    session += 1;
    balances = new Map();
    groupRuns = new Map(); // none busy here: lock is refused while armed
    knownMints = new Map();
  };

  const install = (opened: OpenedKeystore): void => {
    const next = toUnlocked(opened);
    lock();
    unlocked = next;
  };

  /** The open fleet's network; a locked vault touches no network at all. */
  const networkOf = (vault: UnlockedVault | null): Network =>
    vault?.settings.global.network ?? DEFAULT_NETWORK;

  /** The fleet's groups: the saved ones, or one with every wallet (BUNNDLY-68). */
  const groupsOf = (vault: UnlockedVault): readonly WalletGroupV1[] =>
    effectiveGroups(
      vault.settings.groups,
      vault.publicWallets.map((w) => w.index),
    );

  /** The group a request names; with one group the name may be left out. */
  const groupFor = (vault: UnlockedVault, raw: unknown): WalletGroupV1 => {
    const groups = groupsOf(vault);
    const [only, ...more] = groups;
    if (raw === undefined) return only !== undefined && more.length === 0 ? only : badRequest();
    return groups.find((g) => g.id === raw) ?? badRequest();
  };

  const status = (): VaultStatus => {
    const groups =
      unlocked === null
        ? []
        : groupsOf(unlocked).map((g) => {
            const run = groupRuns.get(g.id);
            return {
              id: g.id,
              armed: run !== undefined && groupBusy(run),
              buy: run?.buy ? { ...run.buy.status } : null,
              watch: run?.watch?.status() ?? null,
            };
          });
    // The fields from before groups show the first running buy and the first arming.
    const watching = allRuns().find(watchActive) ?? allRuns().find((r) => r.watch !== null);
    const buying = allRuns().find((r) => r.buy !== null);
    return {
      locked: unlocked === null,
      network: networkOf(unlocked),
      armed: isArmed(),
      info: unlocked ? infoOf(unlocked) : null,
      buy: buying?.buy ? { ...buying.buy.status } : null,
      watch: watching?.watch?.status() ?? null,
      groups,
    };
  };

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
    if (unlocked !== null && !isArmed() && now() - lastActivity >= autoLockMs()) {
      lock();
      return true;
    }
    return false;
  };

  const createTransport = options.chain?.createTransport ?? createHttpTransport;

  /**
   * A custom endpoint serves only the network its host names; on the other network the
   * address built from the Helius key applies (D-041).
   */
  const customFor = (url: string | undefined, network: Network): string | null =>
    url !== undefined && endpointNetwork(url) === network ? url : null;

  const rpcUrlOf = (vault: UnlockedVault): string | null => {
    const { apiKeys } = vault;
    const network = networkOf(vault);
    return (
      customFor(apiKeys.heliusRpcUrl, network) ??
      (apiKeys.helius === undefined ? null : heliusRpcUrl(network, apiKeys.helius))
    );
  };

  const wsUrlOf = (vault: UnlockedVault): string | null => {
    const { apiKeys } = vault;
    const network = networkOf(vault);
    return (
      customFor(apiKeys.heliusWsUrl, network) ??
      (apiKeys.helius === undefined ? null : heliusWsUrl(network, apiKeys.helius))
    );
  };

  /** Buying needs a route on the fleet's network; devnet has none yet (D-041). */
  const requireBuyRoute = (vault: UnlockedVault): void => {
    if (buyRouteOf(networkOf(vault)) === null) throw new AppError('NO_BUY_ROUTE_ON_NETWORK');
  };

  /**
   * Reads SOL balances with the Helius key, which never leaves the worker (D-016). Not
   * user activity: periodic refreshes must not keep the vault unlocked.
   */
  const prepareRefresh = (mint: unknown): (() => Promise<VaultBalances>) => {
    if (mint !== undefined && typeof mint !== 'string') return badRequest();
    checkAutoLock();
    const vault = requireUnlocked();
    const url = rpcUrlOf(vault);
    if (url === null) throw new AppError('HELIUS_KEY_MISSING');
    const wallets = [...vault.publicWallets];
    const readSession = session;
    const network = networkOf(vault);
    return async () => {
      let source: RpcSource = 'helius';
      const transport = createResilientTransport({
        primary: createTransport(url),
        fallback: createTransport(publicRpcUrl(network)),
        ...(options.chain?.sleep ? { sleep: options.chain.sleep } : {}),
        onSource: (s) => {
          if (s === 'fallback') source = 'fallback';
        },
      });
      const rpc = createBalancesRpc(transport);
      const owners = wallets.map((w) => w.address);
      let lamports: bigint[];
      let token: VaultBalances['token'];
      try {
        lamports = await fetchSolBalances(rpc, owners);
        if (mint !== undefined) {
          const t = await fetchTokenBalances(rpc, mint, owners);
          token = {
            mint: t.mint,
            program: t.program,
            decimals: t.decimals,
            balances: wallets.map((w, i) => ({ index: w.index, amount: t.amounts[i] ?? 0n })),
          };
        }
      } catch (e) {
        // Only our own codes cross; anything else may carry the URL with the key.
        throw isAppError(e) ? e : new AppError('RPC_UNAVAILABLE');
      }
      // Locked (or another fleet opened) while reading: do not hand out stale data.
      if (session !== readSession || unlocked === null) throw new AppError('VAULT_LOCKED');
      // The network changed while reading: the answer is labelled with the network it
      // came from and never becomes the pre-check balance of the new one.
      if (networkOf(unlocked) === network) {
        balances = new Map(wallets.map((w, i) => [w.index, lamports[i] ?? 0n]));
      }
      return {
        network,
        balances: wallets.map((w, i) => ({ index: w.index, lamports: lamports[i] ?? 0n })),
        ...(token ? { token } : {}),
        source,
        fetchedAt: new Date(now()).toISOString(),
      };
    };
  };

  /**
   * Connection test (BUNNDLY-16). Like refreshBalances, only reading the keys is queued;
   * the three checks run in parallel outside the queue and never throw. A click on the
   * button is user activity.
   */
  const prepareConnectionTest = (): (() => Promise<ConnectionReport>) => {
    checkAutoLock();
    const vault = requireUnlocked();
    touch();
    const network = networkOf(vault);
    const rpcUrl = rpcUrlOf(vault);
    const wsUrl = wsUrlOf(vault);
    const jupiterKey = vault.apiKeys.jupiter ?? null;
    // No request leaves for Jupiter on a network it does not serve.
    const withJupiter = buyRouteOf(network) === 'jupiter';
    const net = options.net ?? {};
    const fetchFn: FetchLike = net.fetch ?? ((url, init) => globalThis.fetch(url, init));
    const createWebSocket: WebSocketFactory = net.createWebSocket ?? ((url) => new WebSocket(url));
    const timeoutMs = net.timeoutMs ?? CONNECTION_TEST_TIMEOUT_MS;
    const clock = net.clock ?? (() => performance.now());
    const missing = { ok: false, ms: null, problem: 'KEY_MISSING', httpStatus: null } as const;
    return async () => {
      const [heliusHttp, heliusWs, jupiter] = await Promise.all([
        rpcUrl === null
          ? { ...missing, slot: null }
          : checkHeliusHttp({ url: rpcUrl, fetch: fetchFn, timeoutMs, clock }),
        wsUrl === null
          ? { ...missing, connectMs: null, firstEventMs: null, slot: null }
          : checkHeliusWs({ url: wsUrl, createWebSocket, timeoutMs, clock }),
        withJupiter
          ? checkJupiterQuote({ apiKey: jupiterKey, fetch: fetchFn, timeoutMs, clock })
          : null,
      ]);
      if (unlocked !== vault) throw new AppError('VAULT_LOCKED');
      return { network, heliusHttp, heliusWs, jupiter, testedAt: new Date(now()).toISOString() };
    };
  };

  const emit = (event: WorkerEvent): void => {
    for (const listener of listeners) listener(event);
  };

  const limitersFor = (plan: FleetSettingsV1['global']['jupiterPlan'], orderRpm: number) => {
    const key = `${plan}:${String(orderRpm)}`;
    let pair = limiters.get(key);
    if (pair === undefined) {
      const clock = options.executor?.clock ?? realClock;
      pair = {
        order: new OrderLimiter({
          orderRpm,
          clock,
          ...(options.executor?.steady === undefined ? {} : { steady: options.executor.steady }),
        }),
        execute: new ExecuteLimiter({ plan, orderRpm, clock }),
      };
      limiters.set(key, pair);
    }
    return pair;
  };

  /**
   * The group's wallets with a buy amount: their own (SOL or a percent) or the fleet
   * default (BUNNDLY-58). A percent becomes lamports from the last balance read, never into
   * the reserve; an unread balance is skipped by the executor before the amount matters.
   * `list` names the wallets (BUNNDLY-59) and the saved selection plays no part; without
   * it the group's active wallets buy.
   */
  const buyWallets = (
    vault: UnlockedVault,
    group: WalletGroupV1,
    list: readonly number[] | null = null,
  ): ExecutorWallet[] => {
    const { settings } = vault;
    const inactive = new Set(settings.active.filter((a) => !a.active).map((a) => a.index));
    const spend = new Map(settings.maxSpend.map((m) => [m.index, m.lamports]));
    const members = new Set(group.wallets);
    const listed = list === null ? null : new Set(list);
    const takes = (index: number): boolean =>
      members.has(index) && (listed === null ? !inactive.has(index) : listed.has(index));
    const wallets = vault.publicWallets.flatMap((w): ExecutorWallet[] => {
      if (!takes(w.index)) return [];
      const sol = spend.get(w.index);
      const t = walletTrade(
        settings.trade,
        w.index,
        sol !== undefined && sol > 0n ? sol : undefined,
      );
      if (t.buyAmount === null) return [];
      const balance = balances.get(w.index) ?? null;
      const maxSpend =
        t.buyAmount.kind === 'lamports'
          ? t.buyAmount.lamports
          : balance === null
            ? 0n
            : percentBuyAmount(balance, t.buyAmount.percent, settings.global.minReserveLamports);
      return [
        {
          index: w.index,
          address: w.address,
          maxSpend,
          balance,
          ...(t.buySlippageBps === null ? {} : { slippageBps: t.buySlippageBps }),
        },
      ];
    });
    if (wallets.length === 0) throw new AppError('NO_WALLETS_TO_BUY');
    // Live mode never retries without the chain check, which needs the RPC.
    if (
      !vault.settings.global.dryRun &&
      rpcUrlOf(vault) === null &&
      options.executor?.landing === undefined
    ) {
      throw new AppError('HELIUS_KEY_MISSING');
    }
    return wallets;
  };

  /**
   * startBuy (BUNNDLY-21): runs the executor in the worker; progress goes out as events.
   * Mode B passes the detection (`trigger`): times count from it and the first `/order`
   * is reported back for `reactionMs` (BUNNDLY-34).
   */
  const startBuy = (
    group: WalletGroupV1,
    rawMint: unknown,
    trigger: BuyTrigger | null = null,
    list: readonly number[] | null = null,
  ): BuyStatus => {
    const vault = requireUnlocked();
    if (runOf(group.id).buy !== null) throw new AppError('BUY_RUNNING');
    requireBuyRoute(vault);
    const mint = mintOf(rawMint);
    return launch(vault, group.id, 'buy', mint, buyWallets(vault, group, list), trigger);
  };

  /**
   * Kind of a pasted address (BUNNDLY-59), read through Helius with the public RPC as the
   * fallback (or the public RPC alone without a key: DRY-RUN may run without Helius).
   */
  const classify = async (vault: UnlockedVault, target: string): Promise<TargetKind> => {
    const network = networkOf(vault);
    const key = `${network}:${target}`;
    const known = knownMints.get(key);
    if (known !== undefined) return known;
    const readSession = session;
    const publicUrl = publicRpcUrl(network);
    const transport = createResilientTransport({
      primary: createTransport(rpcUrlOf(vault) ?? publicUrl),
      fallback: createTransport(publicUrl),
      ...(options.chain?.sleep ? { sleep: options.chain.sleep } : {}),
    });
    let kind: TargetKind;
    try {
      kind = await fetchTarget(createBalancesRpc(transport), target);
    } catch (e) {
      // Only our own codes cross; anything else may carry the URL with the key.
      throw isAppError(e) ? e : new AppError('RPC_UNAVAILABLE');
    }
    if (session !== readSession || unlocked === null) throw new AppError('VAULT_LOCKED');
    if (kind.kind === 'mint') knownMints.set(key, kind);
    return kind;
  };

  /** A manual buy: the target must be a token mint, checked before anything starts. */
  const startManualBuy = async (request: VaultRequestOf<'startBuy'>): Promise<BuyStatus> => {
    const vault = requireUnlocked();
    const group = groupFor(vault, request.group);
    const list = walletListOf(request.wallets, group);
    if (runOf(group.id).buy !== null) throw new AppError('BUY_RUNNING');
    requireBuyRoute(vault);
    const mint = mintOf(request.mint);
    buyWallets(vault, group, list); // no RPC read for a buy that cannot start
    if ((await classify(vault, mint)).kind !== 'mint') throw new AppError('TARGET_KIND_MISMATCH');
    return startBuy(group, mint, null, list);
  };

  const mintOf = (rawMint: unknown): string => {
    const mint = str(rawMint).trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/u.test(mint) || mint === SOL_MINT) {
      throw new AppError('INVALID_MINT_ADDRESS');
    }
    return mint;
  };

  /** RPC of the open fleet's network, Helius first; null without a Helius key. */
  const runTransport = (vault: UnlockedVault): RpcTransport | null => {
    const rpcUrl = rpcUrlOf(vault);
    return rpcUrl === null
      ? null
      : createResilientTransport({
          primary: createTransport(rpcUrl),
          fallback: createTransport(publicRpcUrl(networkOf(vault))),
          ...(options.chain?.sleep ? { sleep: options.chain.sleep } : {}),
        });
  };

  const tokenReader = (transport: RpcTransport | null, mint: string): TokenReader | null =>
    options.executor?.tokens ??
    (transport === null
      ? null
      : async (owners) => {
          const t = await fetchTokenBalances(createBalancesRpc(transport), mint, owners);
          return { amounts: t.amounts, slot: t.slot };
        });

  /**
   * startSell (BUNNDLY-60): reads the token balances now, plans each listed wallet's part
   * and runs the executor with the mints swapped. The plan stays here: the signer refuses
   * a sell order above it, whatever the executor asked for.
   */
  const startSell = async (
    group: WalletGroupV1,
    rawMint: unknown,
    rawWallets: unknown,
    rawPercent: unknown,
  ): Promise<BuyStatus> => {
    const vault = requireUnlocked();
    const run = runOf(group.id);
    // A sell is a command of its own; an armed watcher buys and must not meet one.
    if (watchActive(run)) throw new AppError('WATCH_ARMED');
    if (run.buy !== null) throw new AppError('BUY_RUNNING');
    requireBuyRoute(vault);
    const mint = mintOf(rawMint);
    // Without a percent in the request each wallet sells its own part (BUNNDLY-58).
    if (rawPercent !== undefined && !isSellPercent(rawPercent)) return badRequest();
    if (!Array.isArray(rawWallets)) return badRequest();
    const known = new Map(vault.publicWallets.map((w) => [w.index, w]));
    const indices: unknown[] = rawWallets;
    const picked = indices.map((i) => known.get(int(i)) ?? badRequest());
    if (new Set(picked).size !== picked.length) return badRequest();
    // Only the group's own wallets: another group may be buying with the rest.
    if (!picked.every((w) => group.wallets.includes(w.index))) return badRequest();
    if (picked.length === 0) throw new AppError('NO_WALLETS_TO_SELL');
    // A sell is planned from a balance read, in DRY-RUN too.
    const read = tokenReader(runTransport(vault), mint);
    if (read === null) throw new AppError('HELIUS_KEY_MISSING');
    // Live mode never retries without the chain check, which needs the RPC.
    if (
      !vault.settings.global.dryRun &&
      rpcUrlOf(vault) === null &&
      options.executor?.landing === undefined
    ) {
      throw new AppError('HELIUS_KEY_MISSING');
    }
    const readSession = session;
    let amounts: readonly bigint[];
    try {
      amounts = (await read(picked.map((w) => w.address))).amounts;
    } catch (e) {
      // Only our own codes cross; anything else may carry the URL with the key.
      throw isAppError(e) ? e : new AppError('RPC_UNAVAILABLE');
    }
    // Auto-lock runs outside the request queue and may lock the vault while it reads. A buy
    // cannot start meanwhile: requests are queued and a watcher armed before is refused.
    if (session !== readSession || unlocked === null) throw new AppError('VAULT_LOCKED');
    const { trade } = unlocked.settings;
    const wallets = picked.map((w, i): ExecutorWallet => {
      const t = walletTrade(trade, w.index, undefined);
      return {
        index: w.index,
        address: w.address,
        maxSpend: sellAmount(amounts[i] ?? 0n, rawPercent ?? t.sellPercent),
        balance: balances.get(w.index) ?? null,
        ...(t.sellSlippageBps === null ? {} : { slippageBps: t.sellSlippageBps }),
      };
    });
    return launch(unlocked, group.id, 'sell', mint, wallets, null);
  };

  /**
   * True when the new settings change what a wallet of the running buy or sell trades
   * with: its own value or a fleet default it takes (BUNNDLY-58). The run keeps the
   * amounts of its start either way; the refusal keeps the table honest about them.
   */
  const changesRunWallets = (
    vault: UnlockedVault,
    before: FleetSettingsV1,
    after: FleetSettingsV1,
  ): boolean => {
    const planned = allRuns().flatMap((r) =>
      r.runPlan === null ? [] : [...r.runPlan.amounts.keys()],
    );
    // An armed group buys with what its wallets have at the detection, active or not
    // included (D-039 as relaxed by BUNNDLY-68): they stay as they were at arming.
    const armed = groupsOf(vault).flatMap((g) => {
      const run = groupRuns.get(g.id);
      return run !== undefined && watchActive(run) ? g.wallets : [];
    });
    if (planned.length === 0 && armed.length === 0) return false;
    const solOf = (s: FleetSettingsV1, index: number): bigint | undefined => {
      const lamports = s.maxSpend.find((m) => m.index === index)?.lamports;
      return lamports !== undefined && lamports > 0n ? lamports : undefined;
    };
    const key = (s: FleetSettingsV1, index: number): string =>
      JSON.stringify(walletTrade(s.trade, index, solOf(s, index)), (_k, v: unknown) =>
        typeof v === 'bigint' ? v.toString() : v,
      );
    const activeOf = (s: FleetSettingsV1, index: number): boolean =>
      s.active.find((a) => a.index === index)?.active ?? true;
    return (
      planned.some((i) => key(before, i) !== key(after, i)) ||
      armed.some(
        (i) => key(before, i) !== key(after, i) || activeOf(before, i) !== activeOf(after, i),
      )
    );
  };

  /**
   * True when the new settings change what an armed watcher's buy depends on: the global
   * settings it reads at the detection (all but the explorer and the auto-lock time) or
   * the API keys (D-039 as relaxed by BUNNDLY-68).
   */
  const changesArmedGlobals = (
    before: FleetSettingsV1,
    after: FleetSettingsV1,
    keysBefore: ApiKeysV1,
    keysAfter: ApiKeysV1,
  ): boolean => {
    const free: readonly string[] = ['explorer', 'autoLockMinutes'];
    const globals = (Object.keys(before.global) as (keyof GlobalSettingsV1)[]).filter(
      (k) => !free.includes(k),
    );
    return (
      globals.some((k) => before.global[k] !== after.global[k]) ||
      API_KEY_NAMES.some((name) => keysBefore[name] !== keysAfter[name])
    );
  };

  /**
   * True when a busy group (buying, selling or armed) would gain or lose a wallet: its
   * members stay as they were at its start until it ends (BUNNDLY-68). A name may change.
   */
  const changesBusyGroups = (
    vault: UnlockedVault,
    after: readonly WalletGroupV1[],
    afterIndices: readonly number[],
  ): boolean => {
    const next = effectiveGroups(after, afterIndices);
    const members = (g: WalletGroupV1): string => [...g.wallets].sort((a, b) => a - b).join(',');
    return groupsOf(vault).some((g) => {
      const run = groupRuns.get(g.id);
      if (run === undefined || !groupBusy(run)) return false;
      const same = next.find((n) => n.id === g.id);
      return same === undefined || members(same) !== members(g);
    });
  };

  /** Starts the executor for a buy or a sell and keeps it as the running one. */
  const launch = (
    vault: UnlockedVault,
    groupId: string,
    side: Side,
    mint: string,
    wallets: readonly ExecutorWallet[],
    trigger: BuyTrigger | null,
  ): BuyStatus => {
    const selling = side === 'sell';
    const { global } = vault.settings;
    const live = !global.dryRun;
    const injected = options.executor;
    const transport = runTransport(vault);
    const landing: LandingChecker =
      injected?.landing ??
      (transport === null
        ? // DRY-RUN never calls /execute, so it never checks the chain.
          () => Promise.resolve({ status: 'pending' })
        : createLandingChecker(createLandingRpc(transport), { now }));
    const tokens = tokenReader(transport, mint);
    const sol: SolReader | undefined =
      injected?.sol ??
      (transport === null
        ? undefined
        : (owners) => fetchSolBalances(createBalancesRpc(transport), owners));
    const clock = injected?.clock ?? realClock;
    const runId = nextRunId++;
    // After CONFIRMED: the token balance must have grown (BUNNDLY-25), or for a sell
    // fallen, with more SOL in the wallet (BUNNDLY-60). Live mode only.
    const verifier =
      live && tokens !== null
        ? createVerifier(
            { read: tokens, clock, emit, ...(selling && sol !== undefined ? { sol } : {}) },
            { runId, wallets, ...(selling ? { side } : {}) },
          )
        : null;
    const runEmit = (event: ExecutorEvent): void => {
      emit(event);
      if (verifier !== null && event.kind === 'wallet' && event.state === 'CONFIRMED') {
        // What moved the token balance: the output of a buy, the input of a sell.
        const moved = selling ? event.result?.totalInputAmount : event.result?.totalOutputAmount;
        verifier.confirmed(event.index, event.result?.slot ?? null, moved ?? null);
      }
    };
    const net = options.net ?? {};
    const client =
      options.executor?.jupiter ??
      createJupiterClient({
        apiKey: vault.apiKeys.jupiter ?? null,
        fetch: net.fetch ?? ((url, init) => globalThis.fetch(url, init)),
      });
    const jupiter: JupiterClient =
      trigger === null
        ? client
        : {
            getOrder: (request) => {
              const answer = client.getOrder(request); // the request is on its way
              trigger.onFirstOrder();
              return answer;
            },
            execute: (request) => client.execute(request),
          };
    // Without a Jupiter key the API applies Keyless limits, not the plan in the settings.
    const effective = effectiveJupiterPlan(global, vault.apiKeys.jupiter !== undefined);
    const pair = limitersFor(effective.plan, effective.orderRpm);
    const group = runOf(groupId);
    group.runPlan = { side, mint, amounts: new Map(wallets.map((w) => [w.index, w.maxSpend])) };
    const run = startRun(
      {
        jupiter,
        orderLimiter: pair.order,
        executeLimiter: pair.execute,
        sign: signOrder,
        landing,
        clock,
        emit: runEmit,
      },
      {
        runId,
        ...(selling ? { side } : {}),
        mint,
        wallets,
        dryRun: global.dryRun,
        maxAttempts: global.maxAttempts,
        minReserveLamports: global.minReserveLamports,
        priceCeilingPercent: global.priceCeilingPercent,
        noRouteWindowMs: global.noRouteWindowMs,
        noRouteBackoffMinMs: global.noRouteBackoffMinMs,
        noRouteBackoffMaxMs: global.noRouteBackoffMaxMs,
        ...(trigger === null ? {} : { triggeredAt: trigger.detectedAt }),
      },
    );
    const current = {
      run,
      status: {
        ...(selling ? { side } : {}),
        runId,
        mint,
        dryRun: global.dryRun,
        wallets: wallets.length,
        accepting: true,
      },
    };
    group.buy = current;
    const finish = (): void => {
      if (group.buy === current) {
        group.buy = null;
        group.runPlan = null;
      }
      touch(); // the user was busy with the buy: the auto-lock timer starts now
      group.watch?.buyFinished(); // the group's next queued detection, if any
    };
    run.done.then(finish, finish);
    return { ...current.status };
  };

  /**
   * arm (BUNNDLY-34): watch the creator; each detection starts a buy (D-038). The
   * balances are read first: a buy without them skips every wallet (BALANCE_UNKNOWN), and
   * a detection must not wait for the RPC.
   */
  const arm = async (
    group: WalletGroupV1,
    rawCreator: unknown,
    rawWallets: unknown,
  ): Promise<VaultStatus> => {
    const vault = requireUnlocked();
    const run = runOf(group.id);
    if (run.buy !== null) throw new AppError('BUY_RUNNING');
    if (watchActive(run)) throw new AppError('WATCH_ARMED');
    requireBuyRoute(vault);
    const network = networkOf(vault);
    const creator = str(rawCreator).trim();
    let bytes: Uint8Array | null;
    try {
      bytes = base58.decode(creator);
    } catch {
      bytes = null;
    }
    if (bytes?.length !== 32 || creator === SOL_MINT) {
      throw new AppError('INVALID_CREATOR_ADDRESS');
    }
    const list = walletListOf(rawWallets, group);
    const wsUrl = wsUrlOf(vault);
    const rpcUrl = rpcUrlOf(vault);
    if (wsUrl === null || rpcUrl === null) throw new AppError('HELIUS_KEY_MISSING');
    buyWallets(vault, group, list); // the same checks as a buy, now rather than at the detection
    const armSession = session;
    if ((await classify(vault, creator)).kind !== 'wallet') {
      throw new AppError('TARGET_KIND_MISMATCH');
    }
    await prepareRefresh(undefined)();
    // Requests run one at a time today (`tail` in `handle`). The checks after the last
    // await keep arm right without that queue too: one watcher per group, none over a buy.
    if (session !== armSession || unlocked === null) throw new AppError('VAULT_LOCKED');
    if (groupBusy(run)) throw new AppError(watchActive(run) ? 'WATCH_ARMED' : 'BUY_RUNNING');
    const rpc = createWatchRpc(
      createResilientTransport({
        primary: createTransport(rpcUrl),
        fallback: createTransport(publicRpcUrl(network)),
        ...(options.chain?.sleep ? { sleep: options.chain.sleep } : {}),
      }),
    );
    const net = options.net ?? {};
    run.watch = startWatch(
      {
        createWebSocket: net.createWebSocket ?? ((url) => new WebSocket(url)),
        signatures: signatureReader(rpc, creator),
        getTransaction: transactionReader(rpc),
        clock: options.executor?.clock ?? realClock,
        perfNow: options.watch?.perfNow ?? (() => performance.now()),
        random: options.watch?.random ?? Math.random,
        refreshBalances: () =>
          session === armSession ? prepareRefresh(undefined)() : Promise.resolve(),
        isBuying: () => run.buy !== null,
        // Only this group's wallets buy what its watcher detects.
        // with the wallets named at arming (BUNNDLY-59)
        startBuy: (trigger) => startBuy(group, trigger.mint, trigger, list).runId,
        emit,
      },
      {
        url: wsUrl,
        network,
        creator,
        mode: vault.settings.global.mode,
        ...(options.watch?.balanceRefreshMs === undefined
          ? {}
          : { balanceRefreshMs: options.watch.balanceRefreshMs }),
      },
    );
    return status();
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

    // Keys must stay while a buy signs or the watcher may start one: no lock and no other
    // fleet until it ends or is disarmed.
    if (request.type === 'create' || request.type === 'unlock' || request.type === 'lock') {
      if (anyBuy()) throw new AppError('BUY_RUNNING');
      if (anyWatch()) throw new AppError('WATCH_ARMED');
    }
    // An armed watcher buys on its own with the settings confirmed at arming: the network
    // stays until it is disarmed (D-039). What else stays is checked per request below.
    if (request.type === 'setNetwork' && anyWatch()) throw new AppError('WATCH_ARMED');

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
        const indices = new Set(vault.wallets.map((w) => w.index));
        const settings = parseSettings(request.settings, indices, vault.settings);
        const apiKeys = applyKeyChanges(vault.apiKeys, request.apiKeys);
        const switched = settings.global.network !== networkOf(vault);
        // An armed watcher keeps the global settings and keys its buy depends on (D-039).
        if (anyWatch() && changesArmedGlobals(vault.settings, settings, vault.apiKeys, apiKeys)) {
          throw new AppError('WATCH_ARMED');
        }
        // A running buy keeps its network to the end.
        if (switched && anyBuy()) throw new AppError('BUY_RUNNING');
        if (changesBusyGroups(vault, settings.groups, [...indices])) {
          throw new AppError('GROUP_RUNNING');
        }
        if (changesRunWallets(vault, vault.settings, settings)) {
          throw new AppError('WALLET_IN_RUN');
        }
        const result = await rebuild(vault, vault.wallets, settings, apiKeys);
        if (switched) balances = new Map(); // they were read on the other network
        return result;
      }
      case 'setNetwork': {
        const vault = requireUnlocked();
        const raw: unknown = request.network;
        const network = NETWORKS.find((n) => n === raw) ?? badRequest();
        if (anyBuy()) throw new AppError('BUY_RUNNING');
        const result = await rebuild(
          vault,
          vault.wallets,
          { ...vault.settings, global: { ...vault.settings.global, network } },
          vault.apiKeys,
        );
        balances = new Map(); // they were read on the other network
        return result;
      }
      case 'addWallets': {
        const vault = requireUnlocked();
        const count = int(request.count);
        const fromIndex = Math.max(...vault.wallets.map((w) => w.index)) + 1;
        if (count < 1 || fromIndex + count > MAX_FLEET_SIZE) {
          throw new AppError('INVALID_DERIVATION_INDEX');
        }
        const newIndices = Array.from({ length: count }, (_, i) => fromIndex + i);
        const groups = withNewWallets(vault.settings.groups, newIndices);
        const indices = [...vault.publicWallets.map((w) => w.index), ...newIndices];
        // New wallets join the first group, which must not be busy.
        if (changesBusyGroups(vault, groups, indices)) throw new AppError('GROUP_RUNNING');
        const derived = deriveWallets(new TextDecoder().decode(vault.mnemonic), fromIndex, count);
        const added = derived.map((d) => ({ index: d.index, secretKey: d.secretKey }));
        try {
          return await rebuild(
            vault,
            [...vault.wallets, ...added],
            { ...vault.settings, groups },
            vault.apiKeys,
          );
        } catch (e) {
          for (const w of added) wipe(w.secretKey);
          throw e;
        }
      }
      case 'classifyTarget':
        return await classify(requireUnlocked(), parseTargetAddress(str(request.address)));
      case 'startBuy':
        return await startManualBuy(request);
      case 'startSell': {
        const vault = requireUnlocked();
        const group = groupFor(vault, request.group);
        return await startSell(group, request.mint, request.wallets, request.percent);
      }
      case 'arm': {
        const vault = requireUnlocked();
        return await arm(groupFor(vault, request.group), request.creator, request.wallets);
      }
      case 'disarm': {
        // Locked: nothing is armed (lock is refused while armed).
        const id = unlocked === null ? null : groupFor(unlocked, request.group).id;
        if (id !== null) groupRuns.get(id)?.watch?.disarm();
        return status();
      }
      case 'stop': {
        // STOP stops only the named group; the others go on.
        const id = unlocked === null ? null : groupFor(unlocked, request.group).id;
        const run = id === null ? undefined : groupRuns.get(id);
        if (run?.buy) {
          run.buy.status = { ...run.buy.status, accepting: false };
          run.buy.run.stop();
        }
        return status();
      }
      case 'exportPlain': {
        const vault = requireUnlocked();
        const password = str(request.password);
        const rawFormat: unknown = request.format;
        const format = rawFormat === 'json' || rawFormat === 'txt' ? rawFormat : badRequest();
        // Encrypt the current state with the session key, then open that file with the
        // given password: a full scrypt derivation and AES-GCM decryption. A wrong
        // password fails here (KEYSTORE_WRONG_PASSWORD_OR_CORRUPTED).
        const labels = new Map(vault.publicWallets.map((w) => [w.index, w.label]));
        const file = await buildKeystoreWithSession(
          toSecrets(vault, vault.wallets, vault.settings, vault.apiKeys),
          { fleetName: vault.fleetName, createdAt: vault.createdAt, labels },
          vault.session,
        );
        const opened = await openKeystore(file, password, progress);
        if (unlocked !== vault) throw new AppError('VAULT_LOCKED');
        return buildPlainExport(opened.file, opened.secrets, format, new Date(now()));
      }
      case 'activity':
        return status();
      default:
        return badRequest();
    }
  };

  const signOrder = async (
    walletIndex: number,
    request: OrderSignRequest,
    order: JupiterOrder,
  ): Promise<SignOrderResult> => {
    const vault = unlocked;
    if (vault === null) return { ok: false, problem: 'VAULT_LOCKED' };
    const signSession = session;
    const stillOpen = (): boolean => unlocked !== null && session === signSession;
    const wallet = vault.publicWallets.find((w) => w.index === walletIndex);
    const secret = vault.wallets.find((w) => w.index === walletIndex);
    if (wallet === undefined || secret === undefined) {
      return { ok: false, problem: 'UNKNOWN_WALLET' };
    }
    // The run of the wallet's group: a wallet is in one group, a group has one run at a
    // time, and its members stay while it runs (BUNNDLY-68).
    const groupId = groupOf(groupsOf(vault), walletIndex);
    const runPlan = groupId === undefined ? null : (groupRuns.get(groupId)?.runPlan ?? null);
    let limit: bigint;
    if (request.inputMint === undefined) {
      // A buy: up to what the running buy fixed for the wallet at its start; outside a run
      // (nothing signs there today) the SOL amount of the settings.
      limit =
        runPlan?.side === 'buy'
          ? (runPlan.amounts.get(walletIndex) ?? 0n)
          : (vault.settings.maxSpend.find((m) => m.index === walletIndex)?.lamports ?? 0n);
    } else {
      // A sell: only the running one, only its mint for SOL, only up to the wallet's plan.
      if (
        runPlan?.side !== 'sell' ||
        runPlan.mint !== request.inputMint ||
        request.outputMint !== SOL_MINT
      ) {
        return { ok: false, problem: 'NO_SELL_PLAN' };
      }
      limit = runPlan.amounts.get(walletIndex) ?? 0n;
    }
    const check = checkOrderTransaction(order, {
      taker: wallet.address,
      ...(request.inputMint === undefined ? {} : { inputMint: request.inputMint }),
      outputMint: request.outputMint,
      amount: request.amount,
      maxSpend: limit,
    });
    if (!check.ok) return check;
    let signed: SignedOrder;
    try {
      signed = await signCheckedOrder(secret.secretKey, check.checked);
    } catch {
      // A lock zeroes the key mid-signing; anything else is a vault bug. Nothing leaks.
      return { ok: false, problem: stillOpen() ? 'SIGNING_FAILED' : 'VAULT_LOCKED' };
    }
    // Locked while signing: the result must not leave a locked vault.
    if (!stillOpen()) return { ok: false, problem: 'VAULT_LOCKED' };
    return { ok: true, ...signed };
  };

  return {
    signOrder,
    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    handle(request: unknown, options: VaultHandleOptions = {}) {
      if (isRecord(request) && request.type === 'testConnections') {
        const prepared = tail.then(() => prepareConnectionTest());
        tail = prepared.then(
          () => undefined,
          () => undefined,
        );
        return prepared.then((run) => run());
      }
      if (isRecord(request) && request.type === 'refreshBalances') {
        // Only the quick preparation is queued; the network read must not hold up other
        // requests such as `lock`.
        const mint = request.mint;
        const prepared = tail.then(() => prepareRefresh(mint));
        tail = prepared.then(
          () => undefined,
          () => undefined,
        );
        return prepared.then((read) => read());
      }
      const run = tail.then(() => dispatch(request, options));
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    checkAutoLock,
    inspect: () => ({ unlocked, armed: isArmed(), lastActivity }),
  };
}

/** Connects a handler to a message port (the worker's `self`, or a MessagePort in tests). */
export function attachVaultHandler(port: VaultPort, handler: VaultHandler): void {
  handler.onEvent((event) => {
    const message: VaultEventEnvelope = { event };
    port.postMessage(message);
  });
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
