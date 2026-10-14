/** Shared setup of the BuyCommands tests, split into several files (BUNNDLY-75). */
import { cleanup, render, screen, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { afterEach, vi } from 'vitest';
import { AppError, type FleetSettingsV1 } from '../../src/core/index.ts';
import type { RunEvent, WalletEvent } from '../../src/executor/index.ts';
import { App } from '../../src/ui/App.tsx';
import type { VaultInfo, VaultRequest, VaultStatus } from '../../src/worker/protocol.ts';
import {
  TARGET_LABEL,
  TARGET_WAIT,
  classifyFake,
  fleetInfo,
  mockStorage,
  mockVault,
  withDefaultGroup,
} from './fakes.ts';
import { eventually } from './settle.ts';
import { enter, setupUser } from './user.ts';

afterEach(cleanup);

export const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const CREATOR = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
export const SIG = `${'3'.repeat(40)}${'A'.repeat(48)}`;
export const SOL = 1_000_000_000n;

export interface Setup {
  readonly count?: number;
  readonly global?: Partial<FleetSettingsV1['global']>;
  readonly probe?: (index: number) => void;
  readonly jupiterKey?: boolean;
  /** Saved max spend per wallet in lamports (default 0.01 SOL each). */
  readonly maxSpend?: readonly bigint[];
  /** How the worker answers startBuy and startSell: at once, never, or with a refusal. */
  readonly start?: 'answer' | 'hold' | 'refuse';
  /** Part of the token balance each wallet sells, by index (BUNNDLY-58); 100 when unset. */
  readonly sellPercent?: Readonly<Record<number, number>>;
}

export function setup({
  count = 3,
  global = {},
  probe,
  jupiterKey = false,
  maxSpend,
  start = 'answer',
  sellPercent = {},
}: Setup = {}) {
  const base = fleetInfo(count);
  let info: VaultInfo = {
    ...base,
    settings: {
      ...base.settings,
      maxSpend: base.wallets.map((w) => ({
        index: w.index,
        lamports: maxSpend?.[w.index] ?? 10_000_000n,
      })),
      global: { ...base.settings.global, ...global },
      trade: {
        ...base.settings.trade,
        wallets: Object.entries(sellPercent).map(([index, percent]) => ({
          index: Number(index),
          sellPercent: percent,
        })),
      },
    },
    apiKeys: { ...base.apiKeys, helius: true, jupiter: jupiterKey },
  };
  let buy: VaultStatus['buy'] = null;
  const status = (): VaultStatus => ({
    locked: false,
    network: info.settings.global.network,
    armed: buy !== null,
    info,
    buy,
    watch: null,
    groups: [],
  });
  const vault = mockVault(status());
  const requests: VaultRequest[] = [];
  vault.request.mockImplementation((req: VaultRequest) => {
    requests.push(req);
    switch (req.type) {
      case 'status':
      case 'activity':
        return Promise.resolve(withDefaultGroup(status()));
      case 'refreshBalances':
        return Promise.resolve({
          balances: info.wallets.map((w) => ({ index: w.index, lamports: SOL })),
          ...(req.mint
            ? {
                token: {
                  mint: req.mint,
                  program: req.mint === MINT ? 'spl-token' : 'token-2022',
                  decimals: req.mint === MINT ? 6 : 9,
                  balances: info.wallets.map((w) => ({ index: w.index, amount: 0n })),
                },
              }
            : {}),
          network: info.settings.global.network,
          source: 'helius',
          fetchedAt: '2026-10-02T12:00:00.000Z',
        });
      case 'classifyTarget':
        return classifyFake(req.address);
      case 'startSell':
      case 'startBuy':
        if (start === 'hold') return new Promise(() => undefined);
        if (start === 'refuse') return Promise.reject(new AppError('BUY_RUNNING'));
        buy = {
          runId: 1,
          mint: req.mint,
          dryRun: info.settings.global.dryRun,
          wallets: count,
          accepting: true,
        };
        return Promise.resolve({ ...buy });
      case 'stop':
        if (buy) buy = { ...buy, accepting: false };
        return Promise.resolve(status());
      case 'saveSettings':
        info = { ...info, settings: { ...info.settings, ...req.settings } };
        return Promise.resolve({ fileText: '{"saved":true}', info });
      default:
        return Promise.reject(new Error(req.type));
    }
  });
  const storage = mockStorage();
  const blobs: Blob[] = [];
  (storage.env.createObjectURL as ReturnType<typeof vi.fn>).mockImplementation((b: Blob) => {
    blobs.push(b);
    return 'blob:log';
  });
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
    requests,
    blobs,
    user: setupUser(),
    finishBuy: () => {
      buy = null;
    },
  };
}

export function runEvent(phase: RunEvent['phase'], wallets = 3): RunEvent {
  return {
    kind: 'run',
    runId: 1,
    at: 0,
    phase,
    mint: MINT,
    dryRun: false,
    wallets,
    counts: {
      IDLE: 0,
      SCHEDULED: 0,
      QUEUED: 0,
      QUOTING: 0,
      SIGNING: 0,
      SUBMITTED: 0,
      CONFIRMED: 0,
      FAILED: 0,
      UNKNOWN: 0,
      SKIPPED: 0,
    },
  };
}

export function walletEvent(
  index: number,
  state: WalletEvent['state'],
  extra: Partial<WalletEvent> = {},
): WalletEvent {
  return {
    kind: 'wallet',
    runId: 1,
    at: 0,
    index,
    state,
    attempt: 1,
    reason: null,
    quote: null,
    result: null,
    times: { orderMs: null, signMs: null, executeMs: null, sinceStartMs: 1_500 },
    ...extra,
  };
}

export async function showMint(user: UserEvent): Promise<void> {
  await eventually(() => screen.getByText(/^Slot \S+ · /u));
  // these tests send to every wallet at once; Stairs is the default since BUNNDLY-93
  await user.click(screen.getByRole('button', { name: 'Immediate' }));
  await enter(user, screen.getByLabelText(TARGET_LABEL), MINT);
  // the worker checks the address after a pause: a wait by the clock, not by turns
  await screen.findByRole('columnheader', { name: 'Tokens (SPL)' }, TARGET_WAIT);
}

/** One part of the page, found by its class, to query inside it. */
export function part(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`no ${selector}`);
  return element;
}

export function row(label: string): HTMLElement {
  const tr = document.querySelector(`input[aria-label="Select ${label}"]`)?.closest('tr');
  if (!tr) throw new Error(`row ${label}`);
  return tr;
}

/** A filter tab, by its label; its name ends with the count. */
export function tabCount(label: string): string {
  const tab = within(screen.getByRole('group', { name: 'Wallet filters' })).getByRole('button', {
    name: new RegExp(`^${label} \\d+$`, 'u'),
  });
  return tab.querySelector('.tab-count')?.textContent ?? '';
}

/** Opens a screen from the top bar (Dashboard, Activity, Settings). */
export async function goTo(user: UserEvent, name: string): Promise<void> {
  await user.click(within(screen.getByRole('navigation')).getByRole('button', { name }));
}

export function summaryValue(term: string): string {
  const dl = screen.getByLabelText('Fleet summary');
  return within(dl).getByText(term).nextElementSibling?.textContent ?? '';
}

/** The signature as the row shortens it: 4 characters, an ellipsis, 4 characters. */
export const SIG_SHORT = '3333…AAAA';

export const stateOf = (label: string): string =>
  // the state chip and the Fill caption both say it
  within(row(label)).queryAllByText('Queued').length === 0 ? 'not queued' : 'Queued';

// Since BUNNDLY-73 the limit is next to the Jupiter plan in Settings, not above Buy.
