// @vitest-environment jsdom
/**
 * Buying on the fleet screen (BUNNDLY-27, command bar BUNNDLY-59): start, events from the
 * mock worker, progress, explorer links, STOP, live mode only after confirmation, render
 * counts at 100 wallets.
 */
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError, type FleetSettingsV1 } from '../../src/core/index.ts';
import type { RunEvent, WalletEvent } from '../../src/executor/index.ts';
import { App } from '../../src/ui/App.tsx';
import type { VaultInfo, VaultRequest, VaultStatus } from '../../src/worker/protocol.ts';
import {
  TARGET_LABEL,
  TARGET_WAIT,
  TOKEN_2022_MINT,
  classifyFake,
  fleetInfo,
  mockStorage,
  mockVault,
  withDefaultGroup,
} from './fakes.ts';
import { eventually } from './settle.ts';
import { setupUser } from './user.ts';

afterEach(cleanup);

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const CREATOR = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const SIG = `${'3'.repeat(40)}${'A'.repeat(48)}`;
const SOL = 1_000_000_000n;

interface Setup {
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

function setup({
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

function runEvent(phase: RunEvent['phase'], wallets = 3): RunEvent {
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

function walletEvent(
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

async function showMint(user: UserEvent): Promise<void> {
  await eventually(() => screen.getByText(/^Balances as of /u));
  await user.type(screen.getByLabelText(TARGET_LABEL), MINT);
  // the worker checks the address after a pause: a wait by the clock, not by turns
  await screen.findByRole('columnheader', { name: 'Tokens (SPL)' }, TARGET_WAIT);
}

/** One part of the page, found by its class, to query inside it. */
function part(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`no ${selector}`);
  return element;
}

function row(label: string): HTMLElement {
  const tr = document.querySelector(`input[aria-label="Select ${label}"]`)?.closest('tr');
  if (!tr) throw new Error(`row ${label}`);
  return tr;
}

/** A filter tab, by its label; its name ends with the count. */
function tabCount(label: string): string {
  const tab = within(screen.getByRole('group', { name: 'Wallet filters' })).getByRole('button', {
    name: new RegExp(`^${label} \\d+$`, 'u'),
  });
  return tab.querySelector('.tab-count')?.textContent ?? '';
}

/** Opens a screen from the top bar (Dashboard, Activity, Settings). */
async function goTo(user: UserEvent, name: string): Promise<void> {
  await user.click(within(screen.getByRole('navigation')).getByRole('button', { name }));
}

function summaryValue(term: string): string {
  const dl = screen.getByLabelText('Fleet summary');
  return within(dl).getByText(term).nextElementSibling?.textContent ?? '';
}

/** The signature as the row shortens it: 4 characters, an ellipsis, 4 characters. */
const SIG_SHORT = '3333…AAAA';

describe('mode A', () => {
  it('BUY only with a mint the worker checked and a ready wallet', async () => {
    const { user, requests } = setup();
    await screen.findByText(/^Balances as of /u);
    const buy = screen.getByRole('button', { name: 'Buy' });
    expect(buy).toHaveProperty('disabled', true);
    await showMint(user);
    expect(screen.getByRole('button', { name: 'Buy' })).toHaveProperty('disabled', false);
    expect(summaryValue('Planned buy')).toBe('0.03 SOL');
    await user.click(screen.getByRole('button', { name: 'Buy' }));
    expect(requests.find((r) => r.type === 'startBuy')).toEqual({
      type: 'startBuy',
      mint: MINT,
      wallets: [0, 1, 2],
      group: 'g1',
    });
  });

  it('BUY sends the wallets selected in the table, saved or not (BUNNDLY-59)', async () => {
    const { user, requests } = setup();
    await screen.findByText(/^Balances as of /u);
    await showMint(user);
    await user.click(screen.getByRole('checkbox', { name: 'Select W02' }));
    await user.click(screen.getByRole('button', { name: 'Buy' }));
    expect(requests.find((r) => r.type === 'startBuy')).toEqual({
      type: 'startBuy',
      mint: MINT,
      wallets: [0, 2],
      group: 'g1',
    });
    expect(requests.filter((r) => r.type === 'saveSettings')).toEqual([]);
  });

  it('a full run of 3 wallets: success, failure, skip; bar, timers, explorer link; STOP', async () => {
    const { user, vault, requests, finishBuy } = setup({
      global: { dryRun: false, explorer: 'orb' },
    });
    await showMint(user);
    await user.click(screen.getByRole('button', { name: 'Buy' }));
    // live mode: nothing leaves before the confirmation (BUNNDLY-59)
    const dialog = screen.getByRole('alertdialog', { name: 'Buy in live mode?' });
    expect(requests.filter((r) => r.type === 'startBuy')).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Yes, buy' }));
    expect(requests.filter((r) => r.type === 'startBuy')).toHaveLength(1);
    act(() => {
      vault.emit(runEvent('started'));
      vault.emit(walletEvent(0, 'QUEUED'));
      vault.emit(walletEvent(1, 'QUEUED'));
      vault.emit(
        walletEvent(2, 'SKIPPED', {
          reason: { kind: 'SKIPPED', code: 'INSUFFICIENT_SOL', detail: null },
        }),
      );
    });
    // fleetFill's wording (BUNNDLY-56): 2 queued wallets in flight, the skipped one skipped
    expect(
      await screen.findByText(/^Fleet fill · 0 of 3 filled · 2 in flight · 1 skipped$/u),
    ).toBeTruthy();
    expect(screen.getByText(/Do not close or reload this tab/u)).toBeTruthy();
    // two queued wallets are in flight; the skipped one needs attention
    expect([tabCount('In flight'), tabCount('Filled'), tabCount('Needs attention')]).toEqual([
      '2',
      '0',
      '1',
    ]);

    // STOP is there for the whole buy and sends stop
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(requests.some((r) => r.type === 'stop')).toBe(true);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Stop' }).getAttribute('aria-description')).toBe(
        'Stopping…',
      );
    });
    expect(screen.getByRole('button', { name: 'Stop' })).toHaveProperty('disabled', true);

    act(() => {
      vault.emit(
        walletEvent(0, 'CONFIRMED', {
          quote: { inAmount: 10_000_000n, outAmount: 2_103n, router: 'metis' },
          result: {
            signature: SIG,
            slot: 1n,
            totalInputAmount: 10_000_000n,
            totalOutputAmount: 2_101_000n,
          },
          times: { orderMs: 100, signMs: 2, executeMs: 900, sinceStartMs: 1_200 },
        }),
      );
      vault.emit(
        walletEvent(1, 'FAILED', {
          attempt: 3,
          reason: { kind: 'FAILED', code: 'MAX_ATTEMPTS', detail: 'NOT_LANDED:-1000' },
          times: { orderMs: 100, signMs: 2, executeMs: 900, sinceStartMs: 64_000 },
        }),
      );
      vault.emit({
        kind: 'verify',
        runId: 1,
        at: 0,
        index: 0,
        status: 'MATCH',
        expected: 2_101_000n,
        observed: 2_101_000n,
      });
      vault.emit(runEvent('finished'));
    });
    finishBuy();
    // W01 MATCH, W02 failed, W03 skipped for want of SOL
    expect(
      await screen.findByText(/^Fleet fill · 1 of 3 filled · 1 failed · 1 skipped$/u),
    ).toBeTruthy();
    // first and last fill: the one confirmation came 1 200 ms after the start
    expect(screen.getByTitle('Counted from the start').textContent).toBe('+1.2 s · +1.2 s');

    // The row says the state and the wallet's last message; the transaction has its column
    // with the time since the start (sinceStartMs 1 200).
    expect(within(row('W01')).getByText('Bought')).toBeTruthy();
    expect(within(row('W01')).getByText('Chain: confirmed')).toBeTruthy();
    const tx = within(row('W01')).getByRole('link', { name: SIG_SHORT });
    expect(tx.getAttribute('href')).toBe(`https://orbmarkets.io/tx/${SIG}`);
    expect(tx.getAttribute('rel')).toBe('noopener noreferrer');
    expect(within(row('W01')).getByText('+1.2 s after start')).toBeTruthy();

    expect(within(row('W02')).getByText('Failed')).toBeTruthy();
    // the message column, and the Fill caption says the same reason
    expect(
      within(row('W02')).getByText('All attempts are used up.', { selector: 'p.cap' }),
    ).toBeTruthy();
    expect(
      within(row('W02')).getByText('All attempts are used up.', { selector: '.fill-cap' }),
    ).toBeTruthy();
    expect(within(row('W02')).queryByRole('link')).toBeNull();

    expect(within(row('W03')).getByText('Skipped')).toBeTruthy();
    expect(within(row('W03')).getByText(/Not enough SOL/u, { selector: 'p.cap' })).toBeTruthy();
    // no row of details any more: header + 3 wallets
    expect(screen.getAllByRole('row')).toHaveLength(4);

    // filled is bought and confirmed on the chain; the failure and the skip need attention
    expect([tabCount('In flight'), tabCount('Filled'), tabCount('Needs attention')]).toEqual([
      '0',
      '1',
      '2',
    ]);
    await user.click(screen.getByRole('button', { name: /^Needs attention/u }));
    expect(screen.queryByRole('checkbox', { name: 'Select W01' })).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Select W02' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Select W03' })).toBeTruthy();
    await user.click(
      within(screen.getByRole('group', { name: 'Wallet filters' })).getByRole('button', {
        name: /^All wallets/u,
      }),
    );
    // one confirmed wallet at 1.2 s: the first and the last fill
    expect(summaryValue('First and last fill')).toBe('+1.2 s · +1.2 s');

    // after the run: BUY works again, the log can be downloaded on the Activity screen
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Buy' })).toHaveProperty('disabled', false);
    });
    await goTo(user, 'Activity');
    expect(screen.getByRole('button', { name: 'Download CSV' })).toHaveProperty('disabled', false);
  });
});

describe('command bar (BUNNDLY-59)', () => {
  const stateOf = (label: string): string =>
    // the state chip and the Fill caption both say it
    within(row(label)).queryAllByText('Queued').length === 0 ? 'not queued' : 'Queued';

  it('BUY marks the selected rows Queued before the worker answers', async () => {
    const { user, requests } = setup({ start: 'hold' });
    await showMint(user);
    await user.click(screen.getByRole('checkbox', { name: 'Select W02' }));
    expect(['W01', 'W02', 'W03'].map(stateOf)).toEqual(['not queued', 'not queued', 'not queued']);
    await user.click(screen.getByRole('button', { name: 'Buy' }));
    // the worker has not answered startBuy: the rows changed in the click
    expect(requests.filter((r) => r.type === 'startBuy')).toHaveLength(1);
    expect(['W01', 'W02', 'W03'].map(stateOf)).toEqual(['Queued', 'not queued', 'Queued']);
    expect(screen.getByRole('button', { name: 'Buy' }).getAttribute('aria-description')).toBe(
      'Sending the command…',
    );
  });

  it('a refused BUY puts the rows back and says why', async () => {
    const { user } = setup({ start: 'refuse' });
    await showMint(user);
    await user.click(screen.getByRole('button', { name: 'Buy' }));
    expect(
      (await screen.findByText(/A buy is running\. Stop it with STOP/u)).closest('[role="alert"]'),
    ).not.toBeNull();
    expect(['W01', 'W02', 'W03'].map(stateOf)).toEqual(['not queued', 'not queued', 'not queued']);
    expect(screen.getByRole('button', { name: 'Buy' })).toHaveProperty('disabled', false);
  });

  it('live: the confirmation sums the saved max spend of the selected wallets only', async () => {
    // 0.01 + 0.025 + 0.1 SOL saved; W02 unselected: 0.01 + 0.1 = 0.11 SOL (all three: 0.135)
    const { user, requests } = setup({
      global: { dryRun: false },
      maxSpend: [10_000_000n, 25_000_000n, 100_000_000n],
    });
    await showMint(user);
    await user.click(screen.getByRole('checkbox', { name: 'Select W02' }));
    await user.click(screen.getByRole('button', { name: 'Buy' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Buy in live mode?' });
    const value = (term: string): string =>
      within(dialog).getByText(term).nextElementSibling?.textContent ?? '';
    expect(value('Wallets')).toBe('2');
    expect(value('Total to spend')).toBe('up to 0.11 SOL');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(requests.filter((r) => r.type === 'startBuy')).toEqual([]);
  });

  it('B buys and Esc stops, but not while typing in the target field', async () => {
    const { user, requests } = setup();
    await showMint(user);
    const field = screen.getByLabelText(TARGET_LABEL);
    expect(document.activeElement).toBe(field);
    await user.keyboard('b');
    expect(requests.filter((r) => r.type === 'startBuy')).toEqual([]);
    expect((field as HTMLInputElement).value).toBe(`${MINT}b`);
    await user.clear(field);
    await user.type(field, MINT);
    await screen.findByText('Token · SPL', {}, TARGET_WAIT);
    // focus off the field, on the page itself
    await user.click(document.body);
    await user.keyboard('b');
    expect(requests.filter((r) => r.type === 'startBuy')).toHaveLength(1);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Stop' })).toHaveProperty('disabled', false);
    });
    await user.keyboard('{Escape}');
    expect(requests.filter((r) => r.type === 'stop')).toHaveLength(1);
  });

  it('the row button buys with that one wallet', async () => {
    const { user, requests } = setup();
    await showMint(user);
    await user.click(screen.getByRole('button', { name: 'Buy W02' }));
    expect(requests.filter((r) => r.type === 'startBuy')).toEqual([
      { type: 'startBuy', mint: MINT, wallets: [1], group: 'g1' },
    ]);
  });

  it('the row Sell sells with that one wallet, selected or not (BUNNDLY-73)', async () => {
    const { user, requests } = setup();
    await showMint(user);
    await user.click(screen.getByRole('checkbox', { name: 'Select W02' }));
    await user.click(screen.getByRole('button', { name: 'Sell W02' }));
    expect(requests.filter((r) => r.type === 'startSell')).toEqual([
      { type: 'startSell', mint: MINT, wallets: [1], group: 'g1' },
    ]);
    expect(requests.filter((r) => r.type === 'startBuy')).toEqual([]);
  });

  it('the row Sell needs a token and says so; live, it asks for one wallet', async () => {
    const { user, requests } = setup({ global: { dryRun: false } });
    await eventually(() => screen.getByText(/^Balances as of /u));
    const sell = (): HTMLElement => screen.getByRole('button', { name: 'Sell W03' });
    expect(sell()).toHaveProperty('disabled', true);
    expect(sell().getAttribute('aria-description')).toBe('Paste the mint of the token to sell.');
    await user.type(screen.getByLabelText(TARGET_LABEL), MINT);
    await screen.findByText('Token · SPL', {}, TARGET_WAIT);
    await user.click(sell());
    const dialog = screen.getByRole('alertdialog', { name: 'Sell in live mode?' });
    expect(within(dialog).getByText('Wallets').nextElementSibling?.textContent).toBe('1');
    expect(requests.filter((r) => r.type === 'startSell')).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Yes, sell' }));
    expect(requests.filter((r) => r.type === 'startSell')).toEqual([
      { type: 'startSell', mint: MINT, wallets: [2], group: 'g1' },
    ]);
  });

  it('SELL sends the mint and the selected wallets; the rows are queued at once', async () => {
    const { user, requests } = setup({ start: 'hold' });
    await showMint(user);
    await user.click(screen.getByRole('checkbox', { name: 'Select W02' }));
    await user.click(screen.getByRole('button', { name: 'Sell' }));
    expect(requests.filter((r) => r.type === 'startSell')).toEqual([
      { type: 'startSell', mint: MINT, wallets: [0, 2], group: 'g1' },
    ]);
    expect(requests.filter((r) => r.type === 'startBuy')).toEqual([]);
    expect(['W01', 'W02', 'W03'].map(stateOf)).toEqual(['Queued', 'not queued', 'Queued']);
  });

  it('S sells, but not while typing in the target field', async () => {
    const { user, requests } = setup();
    await showMint(user);
    await user.keyboard('s');
    expect(requests.filter((r) => r.type === 'startSell')).toEqual([]);
    const field = screen.getByLabelText(TARGET_LABEL);
    await user.clear(field);
    await user.type(field, MINT);
    await screen.findByText('Token · SPL', {}, TARGET_WAIT);
    // focus off the field, on the page itself
    await user.click(document.body);
    await user.keyboard('s');
    expect(requests.filter((r) => r.type === 'startSell')).toHaveLength(1);
  });

  it('live: SELL asks first and names the part each wallet sells', async () => {
    // W02 sells 40 % (its own setting), the others the fleet default of 100 %
    const { user, requests } = setup({ global: { dryRun: false }, sellPercent: { 1: 40 } });
    await showMint(user);
    await user.click(screen.getByRole('button', { name: 'Sell' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Sell in live mode?' });
    const value = (term: string): string =>
      within(dialog).getByText(term).nextElementSibling?.textContent ?? '';
    expect(value('Wallets')).toBe('3');
    expect(value('To sell')).toBe('40–100% of each token balance');
    expect(requests.filter((r) => r.type === 'startSell')).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Yes, sell' }));
    expect(requests.filter((r) => r.type === 'startSell')).toEqual([
      { type: 'startSell', mint: MINT, wallets: [0, 1, 2], group: 'g1' },
    ]);
  });

  it('SELL needs a token and selected wallets, and says so', async () => {
    const { user } = setup();
    await eventually(() => screen.getByText(/^Balances as of /u));
    const sell = (): HTMLElement => screen.getByRole('button', { name: 'Sell' });
    expect(sell()).toHaveProperty('disabled', true);
    expect(sell().getAttribute('aria-description')).toBe('Paste the mint of the token to sell.');
    await user.type(screen.getByLabelText(TARGET_LABEL), MINT);
    await screen.findByText('Token · SPL', {}, TARGET_WAIT);
    expect(sell()).toHaveProperty('disabled', false);
    await user.click(screen.getByRole('checkbox', { name: 'Select all wallets' }));
    expect(sell().getAttribute('aria-description')).toBe('Select the wallets that sell.');
  });

  it('a creator wallet as the target: BUY waits for that creator’s token', async () => {
    const { user } = setup();
    await screen.findByText(/^Balances as of /u);
    await user.type(screen.getByLabelText(TARGET_LABEL), CREATOR);
    await screen.findByText('Creator wallet', {}, TARGET_WAIT);
    const buy = screen.getByRole('button', { name: 'Buy' });
    expect(buy).toHaveProperty('disabled', true);
    expect(buy.getAttribute('aria-description')).toBe(
      'BUY needs a token: arm the watcher and wait for this creator’s token, or paste a mint.',
    );
  });
});

describe('decimals of the bought mint', () => {
  it('the log keeps the decimals of the bought token when another mint is shown later', async () => {
    const { user, vault, blobs } = setup();
    await showMint(user);
    await user.click(screen.getByRole('button', { name: 'Buy' }));
    act(() => {
      vault.emit({ ...runEvent('started'), dryRun: true });
      vault.emit(
        walletEvent(0, 'CONFIRMED', {
          result: {
            signature: SIG,
            slot: 1n,
            totalInputAmount: 10_000_000n,
            totalOutputAmount: 2_101_000n,
          },
        }),
      );
      vault.emit(runEvent('finished'));
    });
    await within(row('W01')).findByText('Bought');
    // another token (9 decimals) in the field: the buy still reads with 6
    const field = screen.getByLabelText(TARGET_LABEL);
    await user.clear(field);
    await user.type(field, TOKEN_2022_MINT);
    await screen.findByRole('columnheader', { name: 'Tokens (Token-2022)' }, TARGET_WAIT);
    await goTo(user, 'Activity');
    await user.click(screen.getByRole('button', { name: 'Download CSV' }));
    const csv = (await blobs.at(-1)?.text()) ?? '';
    // 0.01 SOL for 2 101 000 units of 6 decimals: 0.01 / 2.101, by hand
    expect(csv).toContain('0.004759638267');
  });
});

// Since BUNNDLY-73 the limit is next to the Jupiter plan in Settings, not above Buy.
describe('Jupiter limits in Settings', () => {
  it('shows the plan that applies: Keyless without a key, the Settings plan with one', async () => {
    const first = setup();
    await screen.findByText(/^Balances as of /u);
    await goTo(first.user, 'Settings');
    expect(screen.getByLabelText('Jupiter limit for buys').textContent).toBe(
      'Buys use now: No key (Keyless), 30 /order per minute (no Jupiter API key saved).',
    );
    cleanup();
    const second = setup({ jupiterKey: true });
    await screen.findByText(/^Balances as of /u);
    await goTo(second.user, 'Settings');
    expect(screen.getByLabelText('Jupiter limit for buys').textContent).toBe(
      'Buys use now: Free, 60 /order per minute.',
    );
  });
});

describe('DRY-RUN and live mode', () => {
  // The DRY-RUN switch in the top bar (mockup v2): on means nothing is sent.
  const modeSwitch = (): HTMLElement => screen.getByRole('switch', { name: 'DRY-RUN' });

  it('DRY-RUN is the default for a new fleet and is always labelled', async () => {
    setup();
    expect(
      (await screen.findByRole('switch', { name: 'DRY-RUN' })).getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('live mode needs the confirmation with amount and wallet count; cancel changes nothing', async () => {
    const { user, requests } = setup();
    await screen.findByText(/^Balances as of /u);
    await user.click(modeSwitch());
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('up to 0.03 SOL from 3 wallets');
    expect(requests.some((r) => r.type === 'saveSettings')).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(requests.some((r) => r.type === 'saveSettings')).toBe(false);
    expect(modeSwitch().getAttribute('aria-checked')).toBe('true');

    await user.click(modeSwitch());
    await user.click(screen.getByRole('button', { name: 'Yes, switch to live mode' }));
    await waitFor(() => {
      expect(requests.filter((r) => r.type === 'saveSettings')).toHaveLength(1);
    });
    const saved = requests.find((r) => r.type === 'saveSettings');
    expect(saved?.type === 'saveSettings' && saved.settings.global.dryRun).toBe(false);
    await waitFor(() => {
      expect(modeSwitch().getAttribute('aria-checked')).toBe('false');
    });
    expect(screen.getByText(/Live mode is saved in the vault/u)).toBeTruthy();

    // back to DRY-RUN: no confirmation
    await user.click(modeSwitch());
    await waitFor(() => {
      expect(requests.filter((r) => r.type === 'saveSettings')).toHaveLength(2);
    });
    await waitFor(() => {
      expect(modeSwitch().getAttribute('aria-checked')).toBe('true');
    });
  });
});

describe('transaction links follow the network (BUNNDLY-44)', () => {
  it.each([
    ['solscan', `https://solscan.io/tx/${SIG}?cluster=devnet`],
    ['orb', `https://orbmarkets.io/tx/${SIG}?cluster=devnet`],
    ['solana-explorer', `https://explorer.solana.com/tx/${SIG}?cluster=devnet`],
  ] as const)('devnet fleet, %s: the row links to the devnet page', async (explorer, href) => {
    const { vault } = setup({ global: { network: 'devnet', explorer } });
    await screen.findByText(/^Balances as of /u);
    act(() => {
      vault.emit(runEvent('started'));
      vault.emit(
        walletEvent(0, 'CONFIRMED', {
          result: { signature: SIG, slot: 1n, totalInputAmount: 1n, totalOutputAmount: 1n },
        }),
      );
    });
    await within(row('W01')).findByText('Bought');
    const link = within(row('W01')).getByRole('link', { name: SIG_SHORT });
    expect(link.getAttribute('href')).toBe(href);
  });
});

describe('100 wallets', () => {
  it('events re-render only the rows of their wallets', async () => {
    const renders = new Map<number, number>();
    const probe = (i: number) => {
      renders.set(i, (renders.get(i) ?? 0) + 1);
    };
    const { user, vault } = setup({ count: 100, probe });
    // The steps of `showMint`, with two differences that matter only at 100 rows. Queries
    // by label, role and name run inside the command bar: over the whole page each one
    // works out the accessible name of every control of 100 rows. And the address is
    // pasted, because every typed character renders the screen again (BUNNDLY-65).
    await eventually(() => screen.getByText(/^Balances as of /u));
    const bar = within(part('section.target'));
    await user.click(bar.getByLabelText(TARGET_LABEL));
    await user.paste(MINT);
    await screen.findByRole('columnheader', { name: 'Tokens (SPL)' }, TARGET_WAIT);
    await user.click(within(part('.table-bar')).getByRole('button', { name: 'Buy' }));
    const panel = within(part('dl.summary'));
    act(() => {
      vault.emit(runEvent('started', 100));
      for (let i = 0; i < 100; i++) vault.emit(walletEvent(i, 'QUEUED'));
    });
    await eventually(() => panel.getByText(/Fleet fill · 0 of 100 filled · 100 in flight/u));
    renders.clear();
    act(() => {
      vault.emit(walletEvent(5, 'QUOTING'));
      vault.emit(walletEvent(5, 'SIGNING'));
      vault.emit(walletEvent(42, 'QUOTING'));
    });
    await eventually(() => screen.getAllByText('Signing'));
    // one frame for the batch: rows 5 and 42 once each, no other row
    expect([...renders.keys()].sort((a, b) => a - b)).toEqual([5, 42]);
    expect(renders.get(5)).toBe(1);
  }, 30_000);
});
