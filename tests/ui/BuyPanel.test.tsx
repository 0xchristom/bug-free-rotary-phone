// @vitest-environment jsdom
/**
 * Mode A on the fleet screen (BUNNDLY-27): start, events from the mock worker, progress,
 * explorer links, STOP, live mode only after confirmation, render counts at 100 wallets.
 */
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { FleetSettingsV1 } from '../../src/core/index.ts';
import type { RunEvent, WalletEvent } from '../../src/executor/index.ts';
import { App } from '../../src/ui/App.tsx';
import type { VaultInfo, VaultRequest, VaultStatus } from '../../src/worker/protocol.ts';
import { fleetInfo, mockStorage, mockVault } from './fakes.ts';
import { eventually } from './settle.ts';
import { setupUser } from './user.ts';

afterEach(cleanup);

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SIG = `${'3'.repeat(40)}${'A'.repeat(48)}`;
const SOL = 1_000_000_000n;

interface Setup {
  readonly count?: number;
  readonly global?: Partial<FleetSettingsV1['global']>;
  readonly probe?: (index: number) => void;
  readonly jupiterKey?: boolean;
}

function setup({ count = 3, global = {}, probe, jupiterKey = false }: Setup = {}) {
  const base = fleetInfo(count);
  let info: VaultInfo = {
    ...base,
    settings: {
      ...base.settings,
      maxSpend: base.wallets.map((w) => ({ index: w.index, lamports: 10_000_000n })),
      global: { ...base.settings.global, ...global },
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
  });
  const vault = mockVault(status());
  const requests: VaultRequest[] = [];
  vault.request.mockImplementation((req: VaultRequest) => {
    requests.push(req);
    switch (req.type) {
      case 'status':
      case 'activity':
        return Promise.resolve(status());
      case 'refreshBalances':
        return Promise.resolve({
          balances: info.wallets.map((w) => ({ index: w.index, lamports: SOL })),
          ...(req.mint
            ? {
                token: {
                  mint: req.mint,
                  program: 'spl-token',
                  decimals: req.mint === MINT ? 6 : 9,
                  balances: info.wallets.map((w) => ({ index: w.index, amount: 0n })),
                },
              }
            : {}),
          network: info.settings.global.network,
          source: 'helius',
          fetchedAt: '2026-10-02T12:00:00.000Z',
        });
      case 'startBuy':
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
  await user.type(screen.getByLabelText('Token address (mint)'), MINT);
  await user.click(screen.getByRole('button', { name: 'Show token balance' }));
  await screen.findByRole('columnheader', { name: 'Token (SPL)' });
}

/** One part of the page, found by its class, to query inside it. */
function part(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`no ${selector}`);
  return element;
}

function row(label: string): HTMLElement {
  const tr = screen.getByRole('cell', { name: label }).closest('tr');
  if (!tr) throw new Error('row');
  return tr;
}

describe('mode A', () => {
  it('"Buy now" only with a mint the worker checked and a ready wallet', async () => {
    const { user, requests } = setup();
    await screen.findByText(/^Balances as of /u);
    const buy = screen.getByRole('button', { name: 'Buy now' });
    expect(buy).toHaveProperty('disabled', true);
    await showMint(user);
    expect(screen.getByRole('button', { name: 'Buy now' })).toHaveProperty('disabled', false);
    expect(screen.getByLabelText('Before the buy').textContent).toContain('0.03 SOL');
    await user.click(screen.getByRole('button', { name: 'Buy now' }));
    expect(requests.find((r) => r.type === 'startBuy')).toEqual({ type: 'startBuy', mint: MINT });
  });

  it('a full run of 3 wallets: success, failure, skip; bar, timers, explorer link; STOP', async () => {
    const { user, vault, requests, finishBuy } = setup({
      global: { dryRun: false, explorer: 'orb' },
    });
    await showMint(user);
    await user.click(screen.getByRole('button', { name: 'Buy now' }));
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
    expect(await screen.findByText(/0\/3 confirmed/u)).toBeTruthy();
    expect(screen.getByText(/2 in progress/u)).toBeTruthy();
    expect(screen.getByText(/Do not close or reload this tab/u)).toBeTruthy();

    // STOP is there for the whole buy and sends stop
    await user.click(screen.getByRole('button', { name: 'STOP' }));
    expect(requests.some((r) => r.type === 'stop')).toBe(true);
    expect(await screen.findByRole('button', { name: 'Stopping…' })).toBeTruthy();

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
    expect(await screen.findByText(/1\/3 confirmed/u)).toBeTruthy();
    expect(screen.getByText(/0 in progress · 2 failed or skipped/u)).toBeTruthy();
    expect(screen.getByText(/the first confirmation: 1\.2 s, to the last: 1\.2 s/u)).toBeTruthy();

    const ok = within(row('W01'));
    expect(ok.getByText('Bought')).toBeTruthy();
    expect(ok.getByText('2.101')).toBeTruthy(); // tokens, 6 decimals
    expect(ok.getByText('0.01')).toBeTruthy(); // SOL spent
    expect(ok.getByText('0.004759638267')).toBeTruthy(); // SOL per token
    expect(ok.getByText('confirmed')).toBeTruthy();
    expect(ok.getByRole('link', { name: 'Transaction' }).getAttribute('href')).toBe(
      `https://orbmarkets.io/tx/${SIG}`,
    );
    const failed = within(row('W02'));
    expect(failed.getByText('Failed')).toBeTruthy();
    expect(failed.getByText('All attempts are used up.')).toBeTruthy();
    expect(failed.getByText('3')).toBeTruthy();
    expect(within(row('W03')).getByText('Skipped')).toBeTruthy();
    expect(within(row('W03')).getByText(/Not enough SOL/u)).toBeTruthy();

    // after the run: the log can be downloaded, "Kupuj teraz" is back
    expect(await screen.findByRole('button', { name: 'Buy now' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download CSV' })).toHaveProperty('disabled', false);
  });
});

describe('decimals of the bought mint', () => {
  it('results keep the decimals of the bought token when another mint is shown later', async () => {
    const { user, vault } = setup();
    await showMint(user);
    await user.click(screen.getByRole('button', { name: 'Buy now' }));
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
    expect(await within(row('W01')).findByText('2.101')).toBeTruthy();
    // another token (9 decimals) in the field: the buy still reads with 6
    const field = screen.getByLabelText('Token address (mint)');
    await user.clear(field);
    await user.type(field, 'So11111111111111111111111111111111111111112');
    await user.click(screen.getByRole('button', { name: 'Show token balance' }));
    await waitFor(() => {
      expect(screen.getByLabelText('Before the buy').textContent).toContain('So1111');
    });
    expect(within(row('W01')).getByText('2.101')).toBeTruthy();
    expect(within(row('W01')).getByText('0.004759638267')).toBeTruthy();
  });
});

describe('Jupiter limits in the summary', () => {
  it('shows the plan that applies: Keyless without a key, the Settings plan with one', async () => {
    setup();
    await screen.findByText(/^Balances as of /u);
    expect(screen.getByLabelText('Before the buy').textContent).toContain(
      'No key (Keyless), 30 /order per minute',
    );
    cleanup();
    setup({ jupiterKey: true });
    await screen.findByText(/^Balances as of /u);
    expect(screen.getByLabelText('Before the buy').textContent).toContain(
      'Free, 60 /order per minute',
    );
  });
});

describe('DRY-RUN and live mode', () => {
  it('DRY-RUN is the default for a new fleet and is always labelled', async () => {
    setup();
    expect(await screen.findByLabelText('Mode: DRY-RUN')).toBeTruthy();
  });

  it('live mode needs the confirmation with amount and wallet count; cancel changes nothing', async () => {
    const { user, requests } = setup();
    await screen.findByText(/^Balances as of /u);
    await user.click(screen.getByRole('button', { name: 'Switch to live mode…' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('up to 0.03 SOL from 3 wallets');
    expect(requests.some((r) => r.type === 'saveSettings')).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(requests.some((r) => r.type === 'saveSettings')).toBe(false);
    expect(screen.getByLabelText('Mode: DRY-RUN')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Switch to live mode…' }));
    await user.click(screen.getByRole('button', { name: 'Yes, switch to live mode' }));
    await waitFor(() => {
      expect(requests.filter((r) => r.type === 'saveSettings')).toHaveLength(1);
    });
    const saved = requests.find((r) => r.type === 'saveSettings');
    expect(saved?.type === 'saveSettings' && saved.settings.global.dryRun).toBe(false);
    expect(await screen.findByLabelText('Mode: live')).toBeTruthy();
    expect(screen.getByText(/Live mode is saved in the vault/u)).toBeTruthy();

    // back to DRY-RUN: no confirmation
    await user.click(screen.getByRole('button', { name: 'Back to DRY-RUN' }));
    await waitFor(() => {
      expect(requests.filter((r) => r.type === 'saveSettings')).toHaveLength(2);
    });
    expect(await screen.findByLabelText('Mode: DRY-RUN')).toBeTruthy();
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
    const link = await within(row('W01')).findByRole('link', { name: 'Transaction' });
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
    // by label, role and name run inside the form and the panel they belong to: over the
    // whole page each one works out the accessible name of every control of 100 rows. And
    // the address is pasted, because every typed character renders the screen again. On a
    // busy machine these took most of the 5 s the test has (BUNNDLY-65).
    await eventually(() => screen.getByText(/^Balances as of /u));
    const tokenBar = within(part('form.token-bar'));
    await user.click(tokenBar.getByLabelText('Token address (mint)'));
    await user.paste(MINT);
    await user.click(tokenBar.getByRole('button', { name: 'Show token balance' }));
    await eventually(() => screen.getByRole('columnheader', { name: 'Token (SPL)' }));
    const panel = within(part('section.buy-panel'));
    await user.click(panel.getByRole('button', { name: 'Buy now' }));
    act(() => {
      vault.emit(runEvent('started', 100));
      for (let i = 0; i < 100; i++) vault.emit(walletEvent(i, 'QUEUED'));
    });
    await eventually(() => panel.getByText(/0\/100 confirmed/u));
    expect(panel.getByText(/100 in progress/u)).toBeTruthy();
    renders.clear();
    act(() => {
      vault.emit(walletEvent(5, 'QUOTING'));
      vault.emit(walletEvent(5, 'SIGNING'));
      vault.emit(walletEvent(42, 'QUOTING'));
    });
    await eventually(() => screen.getByText('Signing'));
    // one frame for the batch: rows 5 and 42 once each, no other row
    expect([...renders.keys()].sort((a, b) => a - b)).toEqual([5, 42]);
    expect(renders.get(5)).toBe(1);
  });
});
