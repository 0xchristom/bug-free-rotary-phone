// @vitest-environment jsdom
/**
 * Mode A on the fleet screen (BUNNDLY-27): start, events from the mock worker, progress,
 * explorer links, STOP, live mode only after confirmation, render counts at 100 wallets.
 */
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { FleetSettingsV1 } from '../../src/core/index.ts';
import type { RunEvent, WalletEvent } from '../../src/executor/index.ts';
import { App } from '../../src/ui/App.tsx';
import type { VaultInfo, VaultRequest, VaultStatus } from '../../src/worker/protocol.ts';
import { fleetInfo, mockStorage, mockVault } from './fakes.ts';

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
  const status = (): VaultStatus => ({ locked: false, armed: buy !== null, info, buy });
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
    user: userEvent.setup(),
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

async function showMint(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await screen.findByText(/^Salda z /u);
  await user.type(screen.getByLabelText('Adres tokenu (mint)'), MINT);
  await user.click(screen.getByRole('button', { name: 'Pokaż saldo tokenu' }));
  await screen.findByRole('columnheader', { name: 'Token (SPL)' });
}

function row(label: string): HTMLElement {
  const tr = screen.getByRole('cell', { name: label }).closest('tr');
  if (!tr) throw new Error('row');
  return tr;
}

describe('mode A', () => {
  it('"Kupuj teraz" only with a mint the worker checked and a ready wallet', async () => {
    const { user, requests } = setup();
    await screen.findByText(/^Salda z /u);
    const buy = screen.getByRole('button', { name: 'Kupuj teraz' });
    expect(buy).toHaveProperty('disabled', true);
    await showMint(user);
    expect(screen.getByRole('button', { name: 'Kupuj teraz' })).toHaveProperty('disabled', false);
    expect(screen.getByLabelText('Przed zakupem').textContent).toContain('0,03 SOL');
    await user.click(screen.getByRole('button', { name: 'Kupuj teraz' }));
    expect(requests.find((r) => r.type === 'startBuy')).toEqual({ type: 'startBuy', mint: MINT });
  });

  it('a full run of 3 wallets: success, failure, skip; bar, timers, explorer link; STOP', async () => {
    const { user, vault, requests, finishBuy } = setup({
      global: { dryRun: false, explorer: 'orb' },
    });
    await showMint(user);
    await user.click(screen.getByRole('button', { name: 'Kupuj teraz' }));
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
    expect(await screen.findByText(/0\/3 potwierdzonych/u)).toBeTruthy();
    expect(screen.getByText(/2 w trakcie/u)).toBeTruthy();
    expect(screen.getByText(/Nie zamykaj ani nie przeładowuj tej karty/u)).toBeTruthy();

    // STOP is there for the whole buy and sends stop
    await user.click(screen.getByRole('button', { name: 'STOP' }));
    expect(requests.some((r) => r.type === 'stop')).toBe(true);
    expect(await screen.findByRole('button', { name: 'Zatrzymywanie…' })).toBeTruthy();

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
    expect(await screen.findByText(/1\/3 potwierdzonych/u)).toBeTruthy();
    expect(screen.getByText(/0 w trakcie · 2 nieudanych albo pominiętych/u)).toBeTruthy();
    expect(screen.getByText(/pierwszego potwierdzenia: 1,2 s, do ostatniego: 1,2 s/u)).toBeTruthy();

    const ok = within(row('W01'));
    expect(ok.getByText('Kupiono')).toBeTruthy();
    expect(ok.getByText('2,101')).toBeTruthy(); // tokens, 6 decimals
    expect(ok.getByText('0,01')).toBeTruthy(); // SOL spent
    expect(ok.getByText('0,004759638267')).toBeTruthy(); // SOL per token
    expect(ok.getByText('potwierdzone')).toBeTruthy();
    expect(ok.getByRole('link', { name: 'Transakcja' }).getAttribute('href')).toBe(
      `https://orb.helius.dev/tx/${SIG}`,
    );
    const failed = within(row('W02'));
    expect(failed.getByText('Nieudany')).toBeTruthy();
    expect(failed.getByText('Wyczerpany limit prób.')).toBeTruthy();
    expect(failed.getByText('3')).toBeTruthy();
    expect(within(row('W03')).getByText('Pominięty')).toBeTruthy();
    expect(within(row('W03')).getByText(/Za mało SOL/u)).toBeTruthy();

    // after the run: the log can be downloaded, "Kupuj teraz" is back
    expect(await screen.findByRole('button', { name: 'Kupuj teraz' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pobierz CSV' })).toHaveProperty('disabled', false);
  });
});

describe('decimals of the bought mint', () => {
  it('results keep the decimals of the bought token when another mint is shown later', async () => {
    const { user, vault } = setup();
    await showMint(user);
    await user.click(screen.getByRole('button', { name: 'Kupuj teraz' }));
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
    expect(await within(row('W01')).findByText('2,101')).toBeTruthy();
    // another token (9 decimals) in the field: the buy still reads with 6
    const field = screen.getByLabelText('Adres tokenu (mint)');
    await user.clear(field);
    await user.type(field, 'So11111111111111111111111111111111111111112');
    await user.click(screen.getByRole('button', { name: 'Pokaż saldo tokenu' }));
    await waitFor(() => {
      expect(screen.getByLabelText('Przed zakupem').textContent).toContain('So1111');
    });
    expect(within(row('W01')).getByText('2,101')).toBeTruthy();
    expect(within(row('W01')).getByText('0,004759638267')).toBeTruthy();
  });
});

describe('Jupiter limits in the summary', () => {
  it('shows the plan that applies: Keyless without a key, the Settings plan with one', async () => {
    setup();
    await screen.findByText(/^Salda z /u);
    expect(screen.getByLabelText('Przed zakupem').textContent).toContain(
      'Bez klucza (Keyless), 30 /order na minutę',
    );
    cleanup();
    setup({ jupiterKey: true });
    await screen.findByText(/^Salda z /u);
    expect(screen.getByLabelText('Przed zakupem').textContent).toContain(
      'Free, 60 /order na minutę',
    );
  });
});

describe('DRY-RUN and live mode', () => {
  it('DRY-RUN is the default for a new fleet and is always labelled', async () => {
    setup();
    expect(await screen.findByLabelText('Tryb: DRY-RUN')).toBeTruthy();
  });

  it('live mode needs the confirmation with amount and wallet count; cancel changes nothing', async () => {
    const { user, requests } = setup();
    await screen.findByText(/^Salda z /u);
    await user.click(screen.getByRole('button', { name: 'Przełącz na tryb na żywo…' }));
    const dialog = screen.getByRole('alertdialog');
    expect(dialog.textContent).toContain('do 0,03 SOL z 3 portfeli');
    expect(requests.some((r) => r.type === 'saveSettings')).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Anuluj' }));
    expect(requests.some((r) => r.type === 'saveSettings')).toBe(false);
    expect(screen.getByLabelText('Tryb: DRY-RUN')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Przełącz na tryb na żywo…' }));
    await user.click(screen.getByRole('button', { name: 'Tak, przełącz na tryb na żywo' }));
    await waitFor(() => {
      expect(requests.filter((r) => r.type === 'saveSettings')).toHaveLength(1);
    });
    const saved = requests.find((r) => r.type === 'saveSettings');
    expect(saved?.type === 'saveSettings' && saved.settings.global.dryRun).toBe(false);
    expect(await screen.findByLabelText('Tryb: na żywo')).toBeTruthy();
    expect(screen.getByText(/Tryb na żywo jest zapisany w sejfie/u)).toBeTruthy();

    // back to DRY-RUN: no confirmation
    await user.click(screen.getByRole('button', { name: 'Wróć do DRY-RUN' }));
    await waitFor(() => {
      expect(requests.filter((r) => r.type === 'saveSettings')).toHaveLength(2);
    });
    expect(await screen.findByLabelText('Tryb: DRY-RUN')).toBeTruthy();
  });
});

describe('100 wallets', () => {
  it('events re-render only the rows of their wallets', async () => {
    const renders = new Map<number, number>();
    const probe = (i: number) => {
      renders.set(i, (renders.get(i) ?? 0) + 1);
    };
    const { user, vault } = setup({ count: 100, probe });
    await showMint(user);
    await user.click(screen.getByRole('button', { name: 'Kupuj teraz' }));
    act(() => {
      vault.emit(runEvent('started', 100));
      for (let i = 0; i < 100; i++) vault.emit(walletEvent(i, 'QUEUED'));
    });
    await screen.findByText(/0\/100 potwierdzonych/u);
    expect(screen.getByText(/100 w trakcie/u)).toBeTruthy();
    renders.clear();
    act(() => {
      vault.emit(walletEvent(5, 'QUOTING'));
      vault.emit(walletEvent(5, 'SIGNING'));
      vault.emit(walletEvent(42, 'QUOTING'));
    });
    await screen.findByText('Podpis');
    // one frame for the batch: rows 5 and 42 once each, no other row
    expect([...renders.keys()].sort((a, b) => a - b)).toEqual([5, 42]);
    expect(renders.get(5)).toBe(1);
  });
});
