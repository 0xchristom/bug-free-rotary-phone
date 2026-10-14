/** Shared setup of the FleetTable tests, split into several files (BUNNDLY-75). */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import { AppError } from '../../src/core/errors.ts';
import type { FleetSettingsV1 } from '../../src/core/index.ts';
import { App } from '../../src/ui/App.tsx';
import type { VaultInfo, VaultRequest, VaultStatus } from '../../src/worker/protocol.ts';
import { classifyFake, fleetInfo, mockStorage, mockVault } from './fakes.ts';
import { eventually } from './settle.ts';
import { setupUser } from './user.ts';

export const SOL = 1_000_000_000n;

/** Column positions of the wallet table. */
export const BALANCE = 2;
export const TOKEN = 7;

export interface Setup {
  readonly count?: number;
  readonly settings?: Partial<FleetSettingsV1>;
  readonly lamports?: (index: number) => bigint;
  readonly probe?: (index: number) => void;
  /** Replaces the wallets of the fake fleet (real-looking addresses, other labels). */
  readonly wallets?: VaultInfo['wallets'];
  /** No balance answer until the test lets it through. */
  readonly holdBalances?: boolean;
}

export function setup({
  count = 3,
  settings = {},
  lamports = () => SOL,
  probe,
  wallets,
  holdBalances = false,
}: Setup = {}) {
  const base = fleetInfo(count);
  let info: VaultInfo = {
    ...base,
    ...(wallets ? { wallets } : {}),
    settings: { ...base.settings, ...settings },
  };
  let balanceOf = lamports;
  const status = (): VaultStatus => ({
    locked: false,
    network: info.settings.global.network,
    armed: false,
    info,
    buy: null,
    watch: null,
    groups: [],
  });
  const vault = mockVault(status());
  const saved: Extract<VaultRequest, { type: 'saveSettings' }>['settings'][] = [];
  const added: number[] = [];
  vault.request.mockImplementation((req: VaultRequest) => {
    switch (req.type) {
      case 'status':
      case 'activity':
        return Promise.resolve(status());
      case 'classifyTarget':
        return classifyFake(req.address);
      case 'refreshBalances':
        if (holdBalances) return new Promise(() => undefined);
        if (req.mint === 'NotAMint') return Promise.reject(new AppError('NOT_A_TOKEN_MINT'));
        return Promise.resolve({
          balances: info.wallets.map((w) => ({ index: w.index, lamports: balanceOf(w.index) })),
          ...(req.mint
            ? {
                token: {
                  mint: req.mint,
                  program: 'token-2022',
                  decimals: 6,
                  balances: info.wallets.map((w) => ({
                    index: w.index,
                    amount: BigInt(w.index) * 1_500_000n,
                  })),
                },
              }
            : {}),
          network: info.settings.global.network,
          source: 'helius',
          fetchedAt: '2026-10-02T12:00:00.000Z',
        });
      case 'saveSettings': {
        // like the worker: without trade parameters or groups the current ones stay
        saved.push(req.settings);
        info = {
          ...info,
          settings: {
            ...req.settings,
            trade: req.settings.trade ?? info.settings.trade,
            groups: req.settings.groups ?? info.settings.groups,
          },
        };
        return Promise.resolve({ fileText: '{"saved":true}', info });
      }
      case 'addWallets': {
        added.push(req.count);
        const more = Array.from({ length: req.count }, (_, i) => {
          const index = info.wallets.length + i;
          return {
            index,
            address: `Address${String(index)}`,
            derivationPath: `m/44'/501'/${String(index)}'/0'`,
            label: `Wallet ${String(index)}`,
          };
        });
        info = { ...info, wallets: [...info.wallets, ...more] };
        return Promise.resolve({ fileText: '{"added":true}', info });
      }
      default:
        return Promise.reject(new AppError('INTERNAL_ERROR'));
    }
  });
  const storage = mockStorage();
  render(
    <App
      vault={vault.client}
      storage={storage.env}
      statusPollMs={60_000}
      balanceRefreshMs={60_000}
      {...(probe ? { rowProbe: probe } : {})}
    />,
  );
  return {
    vault,
    saved,
    added,
    storage,
    user: setupUser(),
    setBalances: (f: (index: number) => bigint) => {
      balanceOf = f;
    },
  };
}

/**
 * The wallet's row, found by its selection checkbox. A plain DOM query: a role query with a
 * name works out the name of every element on a page of 100 rows (BUNNDLY-65).
 */
export function row(label: string): HTMLElement {
  const tr = document.querySelector(`input[aria-label="Select ${label}"]`)?.closest('tr');
  if (!tr) throw new Error(`row ${label}`);
  return tr;
}

/**
 * Waits until the first balance read is on screen. A hundred rows take jsdom over a second
 * to build, so the wait is longer than the default one.
 */
export async function ready(): Promise<void> {
  await eventually(() => screen.getByText(/^Slot \S+ · /u));
}

export function cells(label: string): string[] {
  return [...row(label).children].map((c) => c.textContent);
}

export function selectBox(label: string): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>('checkbox', { name: `Select ${label}` });
}

export function headerBox(): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>('checkbox', { name: 'Select all wallets' });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

export function summaryValue(term: string): string {
  const dl = screen.getByLabelText('Fleet summary');
  const dt = within(dl).getByText(term);
  return dt.nextElementSibling?.textContent ?? '';
}
