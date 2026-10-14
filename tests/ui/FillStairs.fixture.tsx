/** Shared setup of the FillStairs tests, split into several files (BUNNDLY-75). */
import { cleanup, render, screen } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { afterEach, vi } from 'vitest';
import type {
  RunEvent,
  StairsOptions,
  VerifyEvent,
  WalletEvent,
} from '../../src/executor/index.ts';
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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

export const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const SOL = 1_000_000_000n;

export function setup({ dryRun = true }: { readonly dryRun?: boolean } = {}) {
  const base = fleetInfo(3);
  const info: VaultInfo = {
    ...base,
    settings: {
      ...base.settings,
      maxSpend: base.wallets.map((w) => ({ index: w.index, lamports: 10_000_000n })),
      global: { ...base.settings.global, dryRun },
    },
    apiKeys: { ...base.apiKeys, helius: true },
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
                  program: 'spl-token',
                  decimals: 6,
                  balances: info.wallets.map((w) => ({ index: w.index, amount: 0n })),
                },
              }
            : {}),
          network: info.settings.global.network,
          source: 'helius',
          fetchedAt: '2026-10-14T12:00:00.000Z',
        });
      case 'classifyTarget':
        return classifyFake(req.address);
      case 'startBuy':
      case 'startSell':
        buy = {
          runId: 1,
          mint: req.mint,
          dryRun,
          wallets: 3,
          accepting: true,
          ...(req.stairs ? { stairs: req.stairs, paused: false } : {}),
        };
        return Promise.resolve({ ...buy });
      case 'pauseStairs':
        if (buy) buy = { ...buy, paused: true };
        return Promise.resolve(withDefaultGroup(status()));
      case 'resumeStairs':
        if (buy) buy = { ...buy, paused: false };
        return Promise.resolve(withDefaultGroup(status()));
      case 'stop':
        if (buy) buy = { ...buy, accepting: false };
        return Promise.resolve(withDefaultGroup(status()));
      default:
        return Promise.reject(new Error(req.type));
    }
  });
  render(
    <App
      vault={vault.client}
      storage={mockStorage().env}
      statusPollMs={60_000}
      balanceRefreshMs={60_000}
    />,
  );
  return { vault, requests, user: setupUser() };
}

export function runEvent(
  phase: RunEvent['phase'],
  dryRun: boolean,
  stairs?: StairsOptions & { paused: boolean },
): RunEvent {
  return {
    kind: 'run',
    runId: 1,
    at: 0,
    phase,
    mint: MINT,
    dryRun,
    wallets: 3,
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
    ...(stairs
      ? {
          stairs: {
            intervalMs: stairs.intervalMs,
            perStep: stairs.perStep,
            step: 1,
            steps: 3,
            paused: stairs.paused,
            nextStepAt: null,
          },
        }
      : {}),
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

export function verifyEvent(index: number, status: VerifyEvent['status']): VerifyEvent {
  return { kind: 'verify', runId: 1, at: 0, index, status, expected: null, observed: null };
}

export async function showMint(user: UserEvent): Promise<void> {
  await eventually(() => screen.getByText(/^Slot \S+ · /u));
  await enter(user, screen.getByLabelText(TARGET_LABEL), MINT);
  await screen.findByRole('columnheader', { name: 'Tokens (SPL)' }, TARGET_WAIT);
}

/** The Fill bar of a wallet: its value and its text. */
export function fillOf(label: string): {
  readonly now: string | null;
  readonly text: string | null;
} {
  const bar = screen.getByRole('progressbar', { name: `Fill of ${label}` });
  return { now: bar.getAttribute('aria-valuenow'), text: bar.getAttribute('aria-valuetext') };
}

/** The rail's message line (BUNNDLY-90). */
export const said = (): string => screen.getByRole('status', { name: 'Last command' }).textContent;

/** Every request the app sent to the fake worker. */
export function requests(vault: ReturnType<typeof mockVault>): VaultRequest[] {
  return vault.request.mock.calls.map(([r]) => r);
}

export function segmentTones(): (string | undefined)[] {
  const segs = screen.getByTestId('fleet-segments');
  return [...segs.querySelectorAll('i')].map((i) => i.dataset.tone);
}

export function toolbar(): HTMLElement {
  const bar = document.querySelector<HTMLElement>('.table-bar');
  if (!bar) throw new Error('no toolbar');
  return bar;
}

/** The state chip in the Status column of a wallet: its text and its tone. */
export function chipOf(label: string): {
  readonly text: string;
  readonly tone: string | undefined;
} {
  const bar = screen.getByRole('progressbar', { name: `Fill of ${label}` });
  const row = bar.closest('tr');
  const chip = row?.querySelector<HTMLElement>('.c-status .k-chip');
  if (!chip) throw new Error(`no state chip in ${label}`);
  return { text: chip.textContent.trim(), tone: chip.dataset.tone };
}

/** The state chip element of a wallet. */
export function chipEl(label: string): HTMLElement {
  const bar = screen.getByRole('progressbar', { name: `Fill of ${label}` });
  const chip = bar.closest('tr')?.querySelector<HTMLElement>('.c-status .k-chip');
  if (!chip) throw new Error(`no state chip in ${label}`);
  return chip;
}

/** The text of a wallet's cell in the column with this header. */
export function cellOf(label: string, header: string): string {
  const th = screen.getByRole('columnheader', { name: header });
  const column = [...(th.parentElement?.children ?? [])].indexOf(th);
  const bar = screen.getByRole('progressbar', { name: `Fill of ${label}` });
  const cell = bar.closest('tr')?.children[column];
  if (!cell) throw new Error(`no ${header} cell in ${label}`);
  return cell.textContent.trim();
}

/** Wallet names in the order the table shows them. */
export function rowOrder(): string[] {
  return screen
    .getAllByRole('progressbar', { name: /^Fill of /u })
    .map((bar) => bar.getAttribute('aria-label')?.replace('Fill of ', '') ?? '?');
}
