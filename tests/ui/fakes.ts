import { vi } from 'vitest';
import { AppError } from '../../src/core/errors.ts';
import { DEFAULT_GLOBAL_SETTINGS } from '../../src/core/settings.ts';
import type { DirectoryHandleLike, StorageEnv } from '../../src/storage/keystore-file.ts';
import type { VaultInfo, VaultRequest, VaultStatus } from '../../src/worker/protocol.ts';
import type { VaultClient, VaultRequestOptions } from '../../src/worker/vault-client.ts';

export const LOCKED: VaultStatus = { locked: true, armed: false, info: null };

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
    settings: { maxSpend: [], active: [], global: DEFAULT_GLOBAL_SETTINGS },
    apiKeys: { helius: false, jupiter: false, heliusRpcUrl: false, heliusWsUrl: false },
  };
}

export function unlocked(armed = false): VaultStatus {
  return { locked: false, armed, info: fleetInfo() };
}

type CreateHandler = (
  req: Extract<VaultRequest, { type: 'create' }>,
  options: VaultRequestOptions,
) => Promise<unknown>;

/** Fake vault worker client; `status` can be changed to simulate auto-lock. */
export function mockVault(initial: VaultStatus, onCreate?: CreateHandler) {
  let status = initial;
  const request = vi.fn(
    (req: VaultRequest, options: VaultRequestOptions = {}): Promise<unknown> => {
      switch (req.type) {
        case 'status':
        case 'activity':
          return Promise.resolve(status);
        case 'lock':
          status = LOCKED;
          return Promise.resolve(status);
        case 'refreshBalances':
          return status.info
            ? Promise.resolve({
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
              status = { locked: false, armed: false, info: (result as { info: VaultInfo }).info };
              return result;
            });
          }
          return Promise.reject(new AppError('INTERNAL_ERROR'));
        default:
          return Promise.reject(new AppError('INTERNAL_ERROR'));
      }
    },
  );
  return {
    client: { request } as unknown as VaultClient,
    request,
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
