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
  PUBLIC_RPC_URL,
  createBalancesRpc,
  createHttpTransport,
  createResilientTransport,
  fetchSolBalances,
  checkHeliusHttp,
  checkHeliusWs,
  fetchTokenBalances,
  type RpcSource,
  type WebSocketFactory,
} from '../chain/index.ts';
import { startRun, type ExecutorEvent, type ExecutorRun } from '../executor/executor.ts';
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
  heliusRpcUrl,
  heliusWsUrl,
  validateGlobalSettings,
  wipe,
  type ApiKeyName,
  type ApiKeysV1,
  type ConnectionReport,
  type FetchLike,
  type FleetSettingsV1,
  type KeystoreSecretsV1,
  type KeystoreSession,
  type OpenedKeystore,
  type PublicWalletV1,
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
  VaultRequestType,
  VaultResponseEnvelope,
  VaultResultMap,
  VaultStatus,
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
}

export interface VaultOptions {
  /** Clock in ms; injectable for tests. */
  readonly now?: () => number;
  readonly chain?: ChainOptions;
  readonly net?: NetOptions;
  readonly executor?: ExecutorOptions;
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
  readonly outputMint: string;
  /** Lamports asked for; must equal the order's inAmount and fit the max spend. */
  readonly amount: bigint;
}

export type SignOrderResult =
  | ({ readonly ok: true } & SignedOrder)
  | {
      readonly ok: false;
      readonly problem: OrderCheckProblem | 'VAULT_LOCKED' | 'UNKNOWN_WALLET' | 'SIGNING_FAILED';
    };

export interface VaultHandler {
  /** Handles one request; requests run strictly one after another. */
  handle(request: unknown, options?: VaultHandleOptions): Promise<VaultResultMap[VaultRequestType]>;
  /**
   * For the executor inside the worker only (BUNNDLY-22, D-028); not reachable through
   * `handle` or the message protocol. Signs the `/order` transaction of one wallet after
   * the checks pass; the max spend comes from the vault's own settings. Never throws.
   */
  signOrder(
    walletIndex: number,
    request: OrderSignRequest,
    order: JupiterOrder,
  ): Promise<SignOrderResult>;
  /** Executor progress (BUNNDLY-21). Returns the unsubscribe function. */
  onEvent(listener: (event: ExecutorEvent) => void): () => void;
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

/** Full settings from the UI; anything malformed or out of range is INVALID_SETTINGS. */
function parseSettings(value: unknown, walletIndices: ReadonlySet<number>): FleetSettingsV1 {
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
  } as FleetSettingsV1['global'];
  if (validateGlobalSettings(global).length > 0) return invalidSettings();
  return { maxSpend, active, global };
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
  let buy: { readonly run: ExecutorRun; status: BuyStatus } | null = null;
  let nextRunId = 1;
  const listeners = new Set<(event: ExecutorEvent) => void>();
  /** Limiters live across runs, so a new buy respects the window of the last one. */
  const limiters = new Map<string, { order: OrderLimiter; execute: ExecuteLimiter }>();
  const isArmed = (): boolean => buy !== null;
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
  };

  const install = (opened: OpenedKeystore): void => {
    const next = toUnlocked(opened);
    lock();
    unlocked = next;
  };

  const status = (): VaultStatus => ({
    locked: unlocked === null,
    armed: isArmed(),
    info: unlocked ? infoOf(unlocked) : null,
    buy: buy === null ? null : { ...buy.status },
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
    if (unlocked !== null && !isArmed() && now() - lastActivity >= autoLockMs()) {
      lock();
      return true;
    }
    return false;
  };

  const createTransport = options.chain?.createTransport ?? createHttpTransport;

  /**
   * Reads SOL balances with the Helius key, which never leaves the worker (D-016). Not
   * user activity: periodic refreshes must not keep the vault unlocked.
   */
  const prepareRefresh = (mint: unknown): (() => Promise<VaultBalances>) => {
    if (mint !== undefined && typeof mint !== 'string') return badRequest();
    checkAutoLock();
    const vault = requireUnlocked();
    const { apiKeys } = vault;
    const url =
      apiKeys.heliusRpcUrl ?? (apiKeys.helius === undefined ? null : heliusRpcUrl(apiKeys.helius));
    if (url === null) throw new AppError('HELIUS_KEY_MISSING');
    const wallets = [...vault.publicWallets];
    const readSession = session;
    return async () => {
      let source: RpcSource = 'helius';
      const transport = createResilientTransport({
        primary: createTransport(url),
        fallback: createTransport(PUBLIC_RPC_URL),
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
      balances = new Map(wallets.map((w, i) => [w.index, lamports[i] ?? 0n]));
      return {
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
    const { apiKeys } = vault;
    const rpcUrl =
      apiKeys.heliusRpcUrl ?? (apiKeys.helius === undefined ? null : heliusRpcUrl(apiKeys.helius));
    const wsUrl =
      apiKeys.heliusWsUrl ?? (apiKeys.helius === undefined ? null : heliusWsUrl(apiKeys.helius));
    const jupiterKey = apiKeys.jupiter ?? null;
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
        checkJupiterQuote({ apiKey: jupiterKey, fetch: fetchFn, timeoutMs, clock }),
      ]);
      if (unlocked !== vault) throw new AppError('VAULT_LOCKED');
      return { heliusHttp, heliusWs, jupiter, testedAt: new Date(now()).toISOString() };
    };
  };

  const emit = (event: ExecutorEvent): void => {
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

  /** startBuy (BUNNDLY-21): runs the executor in the worker; progress goes out as events. */
  const startBuy = (rawMint: unknown): BuyStatus => {
    const vault = requireUnlocked();
    if (buy !== null) throw new AppError('BUY_RUNNING');
    const mint = str(rawMint).trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/u.test(mint) || mint === SOL_MINT) {
      throw new AppError('INVALID_MINT_ADDRESS');
    }
    const { global } = vault.settings;
    const inactive = new Set(vault.settings.active.filter((a) => !a.active).map((a) => a.index));
    const spend = new Map(vault.settings.maxSpend.map((m) => [m.index, m.lamports]));
    const wallets = vault.publicWallets
      .filter((w) => !inactive.has(w.index) && (spend.get(w.index) ?? 0n) > 0n)
      .map((w) => ({
        index: w.index,
        address: w.address,
        maxSpend: spend.get(w.index) ?? 0n,
        balance: balances.get(w.index) ?? null,
      }));
    if (wallets.length === 0) throw new AppError('NO_WALLETS_TO_BUY');
    const net = options.net ?? {};
    const jupiter =
      options.executor?.jupiter ??
      createJupiterClient({
        apiKey: vault.apiKeys.jupiter ?? null,
        fetch: net.fetch ?? ((url, init) => globalThis.fetch(url, init)),
      });
    const pair = limitersFor(global.jupiterPlan, global.orderRpm);
    const runId = nextRunId++;
    const run = startRun(
      {
        jupiter,
        orderLimiter: pair.order,
        executeLimiter: pair.execute,
        sign: signOrder,
        clock: options.executor?.clock ?? realClock,
        emit,
      },
      {
        runId,
        mint,
        wallets,
        dryRun: global.dryRun,
        maxAttempts: global.maxAttempts,
        minReserveLamports: global.minReserveLamports,
      },
    );
    const current = {
      run,
      status: { runId, mint, dryRun: global.dryRun, wallets: wallets.length, accepting: true },
    };
    buy = current;
    const finish = (): void => {
      if (buy === current) buy = null;
      touch(); // the user was busy with the buy: the auto-lock timer starts now
    };
    run.done.then(finish, finish);
    return { ...current.status };
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

    // Keys must stay while a buy signs: no lock and no other fleet until it ends.
    if (
      buy !== null &&
      (request.type === 'create' || request.type === 'unlock' || request.type === 'lock')
    ) {
      throw new AppError('BUY_RUNNING');
    }

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
        return rebuild(
          vault,
          vault.wallets,
          parseSettings(request.settings, indices),
          applyKeyChanges(vault.apiKeys, request.apiKeys),
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
      case 'startBuy':
        return startBuy(request.mint);
      case 'stop':
        if (buy !== null) {
          buy.status = { ...buy.status, accepting: false };
          buy.run.stop();
        }
        return status();
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
    const maxSpend = vault.settings.maxSpend.find((m) => m.index === walletIndex)?.lamports ?? 0n;
    const check = checkOrderTransaction(order, {
      taker: wallet.address,
      outputMint: request.outputMint,
      amount: request.amount,
      maxSpend,
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
