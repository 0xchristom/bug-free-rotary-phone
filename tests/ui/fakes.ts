import { vi } from 'vitest';
import { AppError } from '../../src/core/errors.ts';
import { DEFAULT_GLOBAL_SETTINGS } from '../../src/core/settings.ts';
import { DEFAULT_TRADE_SETTINGS } from '../../src/core/trade.ts';
import type { DirectoryHandleLike, StorageEnv } from '../../src/storage/keystore-file.ts';
import type {
  VaultInfo,
  VaultRequest,
  VaultStatus,
  WorkerEvent,
} from '../../src/worker/protocol.ts';
import type { VaultClient, VaultRequestOptions } from '../../src/worker/vault-client.ts';

export const LOCKED: VaultStatus = {
  locked: true,
  network: 'mainnet',
  armed: false,
  info: null,
  buy: null,
  watch: null,
  groups: [],
};

export function fleetInfo(count = 3, fleetName = 'Flota testowa'): VaultInfo {
  return {
    fleetName,
    createdAt: '2026-10-02T00:00:00.000Z',
    wallets: Array.from({ length: count }, (_, index) => ({
      index,
      address: `Address${String(index)}`,
      derivationPath: `m/44'/501'/${String(index)}'/0'`,
      label: `W${String(index + 1).padStart(2, '0')}`,
    })),
    settings: {
      maxSpend: [],
      active: [],
      global: DEFAULT_GLOBAL_SETTINGS,
      trade: DEFAULT_TRADE_SETTINGS,
      groups: [],
    },
    apiKeys: { helius: false, jupiter: false, heliusRpcUrl: false, heliusWsUrl: false },
  };
}

export function unlocked(armed = false): VaultStatus {
  return {
    locked: false,
    network: 'mainnet',
    armed,
    info: fleetInfo(),
    buy: null,
    watch: null,
    groups: [],
  };
}

type CreateHandler = (
  req: Extract<VaultRequest, { type: 'create' }>,
  options: VaultRequestOptions,
) => Promise<unknown>;

/**
 * The status as the worker sends it (BUNNDLY-68): an open fleet without saved groups has
 * one group, `g1`, whose state is the one the fields from before groups show. A status
 * that lists its groups is sent as it is.
 */
export function withDefaultGroup(status: VaultStatus): VaultStatus {
  if (status.info === null || status.groups.length > 0 || status.info.settings.groups.length > 0) {
    return status;
  }
  return {
    ...status,
    groups: [{ id: 'g1', armed: status.armed, buy: status.buy, watch: status.watch }],
  };
}

/** Fake vault worker client; `status` can be changed to simulate auto-lock. */
export function mockVault(initial: VaultStatus, onCreate?: CreateHandler) {
  let status = initial;
  const request = vi.fn(
    (req: VaultRequest, options: VaultRequestOptions = {}): Promise<unknown> => {
      switch (req.type) {
        case 'status':
        case 'activity':
        case 'resume': // nothing remembered on this device
          return Promise.resolve(withDefaultGroup(status));
        case 'remembered':
          return Promise.resolve({
            available: false,
            account: null,
            prefs: { remember: false, windowMs: null },
          });
        case 'lock':
          status = LOCKED;
          return Promise.resolve(status);
        case 'setNetwork': {
          if (!status.info) return Promise.reject(new AppError('VAULT_LOCKED'));
          if (status.buy !== null) return Promise.reject(new AppError('BUY_RUNNING'));
          if (status.watch?.armed) return Promise.reject(new AppError('WATCH_ARMED'));
          const { settings } = status.info;
          const info: VaultInfo = {
            ...status.info,
            settings: { ...settings, global: { ...settings.global, network: req.network } },
          };
          status = { ...status, network: req.network, info };
          return Promise.resolve({ fileText: `{"network":"${req.network}"}`, info });
        }
        case 'classifyTarget':
          return classifyFake(req.address);
        case 'refreshBalances':
          return status.info
            ? Promise.resolve({
                network: status.network,
                balances: status.info.wallets.map((w) => ({
                  index: w.index,
                  lamports: 1_500_000_000n + BigInt(w.index),
                })),
                source: 'helius',
                fetchedAt: '2026-10-02T12:00:00.000Z',
              })
            : Promise.reject(new AppError('VAULT_LOCKED'));
        case 'create':
          if (onCreate) {
            return onCreate(req, options).then((result) => {
              status = {
                locked: false,
                network: 'mainnet',
                armed: false,
                info: (result as { info: VaultInfo }).info,
                buy: null,
                watch: null,
                groups: [],
              };
              return result;
            });
          }
          return Promise.reject(new AppError('INTERNAL_ERROR'));
        default:
          return Promise.reject(new AppError('INTERNAL_ERROR'));
      }
    },
  );
  const eventListeners = new Set<(event: WorkerEvent) => void>();
  const onEvent = (listener: (event: WorkerEvent) => void) => {
    eventListeners.add(listener);
    return () => {
      eventListeners.delete(listener);
    };
  };
  return {
    client: { request, onEvent } as unknown as VaultClient,
    request,
    /** Pushes an executor event to the UI, like the worker does. */
    emit: (event: WorkerEvent) => {
      for (const l of eventListeners) l(event);
    },
    setStatus: (next: VaultStatus) => {
      status = next;
    },
    calls: (type: VaultRequest['type']) =>
      request.mock.calls.filter(([r]) => r.type === type).length,
  };
}

/** Storage env with an in-memory folder (File System Access API) or download-only. */
export function mockStorage(mode: 'directory' | 'download' = 'directory') {
  const files = new Map<string, string>();
  const dir: DirectoryHandleLike = {
    name: 'Portfele',
    getFileHandle: (name, options) => {
      if (!files.has(name) && !options?.create) {
        return Promise.reject(new DOMException('missing', 'NotFoundError'));
      }
      return Promise.resolve({
        getFile: () =>
          Promise.resolve({ name, size: 0, text: () => Promise.resolve(files.get(name) ?? '') }),
        createWritable: () => {
          let buffer = '';
          return Promise.resolve({
            write: (data: string) => {
              buffer += data;
              return Promise.resolve();
            },
            close: () => {
              files.set(name, buffer);
              return Promise.resolve();
            },
          });
        },
      });
    },
  };
  const showDirectoryPicker = vi.fn(() => Promise.resolve(dir));
  /** The file the next "open" picks; null = the user cancels. */
  let offered: { name: string; text: string } | null = null;
  const env: StorageEnv = {
    ...(mode === 'directory' ? { showDirectoryPicker } : {}),
    pickFileWithInput: () =>
      Promise.resolve(
        offered && {
          name: offered.name,
          size: new TextEncoder().encode(offered.text).length,
          text: () => Promise.resolve(offered?.text ?? ''),
        },
      ),
    createObjectURL: vi.fn(() => 'blob:fake'),
    revokeObjectURL: vi.fn(),
    clickDownload: vi.fn(),
    setTimeout: () => undefined,
  };
  return {
    env,
    files,
    showDirectoryPicker,
    clickDownload: env.clickDownload as ReturnType<typeof vi.fn>,
    /** Makes the next file pick return this file. */
    offerFile: (file: { name: string; text: string } | null) => {
      offered = file;
    },
  };
}

/**
 * Well-formed addresses for the target field (BUNNDLY-59), copied from
 * tests/fixtures/token-accounts.mainnet.json: an SPL mint, a Token-2022 mint and a token
 * account. What the fake worker says about them is set by `classifyFake`.
 */
export const SPL_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const TOKEN_2022_MINT = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo';
export const TOKEN_ACCOUNT = '3Tn7BAWv282J1sH1pqF9gtCdaorRFoVMcTpgCqwPEBvf';

/** The fake worker's answer to classifyTarget: the given mints, a token account, else a wallet. */
export function classifyFake(
  address: string,
  mints: Readonly<Record<string, 'spl-token' | 'token-2022'>> = {
    [SPL_MINT]: 'spl-token',
    [TOKEN_2022_MINT]: 'token-2022',
  },
): Promise<{ kind: 'mint'; program: 'spl-token' | 'token-2022' } | { kind: 'wallet' }> {
  if (address === TOKEN_ACCOUNT) return Promise.reject(new AppError('TARGET_IS_TOKEN_ACCOUNT'));
  const program = mints[address];
  return Promise.resolve(program === undefined ? { kind: 'wallet' } : { kind: 'mint', program });
}

/** The labelled target field of the command bar. */
export const TARGET_LABEL = 'Target: token mint or creator wallet';

/**
 * How long a test waits for the worker's answer about a target: the bar asks 250 ms after
 * the last keystroke, and a full test run on a loaded machine takes longer than the default 1 s.
 */
export const TARGET_WAIT = { timeout: 5_000 } as const;
