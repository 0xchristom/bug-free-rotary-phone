// @vitest-environment jsdom
/**
 * Trade parameters in the wallet table (BUNNDLY-71): the buy amount typed into a row, the
 * lock during a run of the wallet's group, the worker's WALLET_IN_RUN, the Priority fee and
 * Slippage badges, the "Trade settings" popover (row edit button and "Edit selected") and
 * the fleet defaults in Settings.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/core/errors.ts';
import { DEFAULT_TRADE_SETTINGS, type FleetSettingsV1 } from '../../src/core/index.ts';
import type { RunEvent, WalletEvent } from '../../src/executor/index.ts';
import { App } from '../../src/ui/App.tsx';
import { FleetSummaryBar } from '../../src/ui/FleetSummaryBar.tsx';
import type { VaultInfo, VaultRequest, VaultStatus } from '../../src/worker/protocol.ts';
import {
  SPL_MINT,
  TARGET_LABEL,
  TARGET_WAIT,
  classifyFake,
  fleetInfo,
  mockStorage,
  mockVault,
} from './fakes.ts';
import { eventually } from './settle.ts';
import { setupUser } from './user.ts';

afterEach(cleanup);

const SOL = 1_000_000_000n;
const MINT = SPL_MINT;
const LOCKED = 'Can be changed after the run finishes or after STOP.';

type Saved = Extract<VaultRequest, { type: 'saveSettings' }>['settings'];

function setup(settings: Partial<FleetSettingsV1> = {}, { armed = false } = {}) {
  const base = fleetInfo(3);
  let info: VaultInfo = {
    ...base,
    settings: { ...base.settings, ...settings },
    apiKeys: { ...base.apiKeys, helius: true },
  };
  let buy: VaultStatus['buy'] = null;
  let watchArmed = armed;
  let refuse = false;
  const status = (): VaultStatus => ({
    locked: false,
    network: info.settings.global.network,
    armed: buy !== null || watchArmed,
    info,
    buy,
    watch: null,
    groups: [
      {
        id: 'g1',
        armed: buy !== null || watchArmed,
        buy,
        watch: watchArmed
          ? {
              creator: 'Creator',
              armedAt: '2026-10-14T09:00:00.000Z',
              mode: 'one-shot',
              armed: true,
            }
          : null,
      } as VaultStatus['groups'][number],
    ],
  });
  const vault = mockVault(status());
  const saved: Saved[] = [];
  vault.request.mockImplementation((req: VaultRequest) => {
    switch (req.type) {
      case 'status':
      case 'activity':
        return Promise.resolve(status());
      case 'refreshBalances':
        return Promise.resolve({
          balances: info.wallets.map((w) => ({ index: w.index, lamports: 2n * SOL })),
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
          fetchedAt: '2026-10-14T09:00:00.000Z',
        });
      case 'classifyTarget':
        return classifyFake(req.address);
      case 'startBuy':
        buy = { runId: 1, mint: req.mint, dryRun: true, wallets: 2, accepting: true };
        return Promise.resolve({ ...buy });
      case 'saveSettings':
        if (refuse) return Promise.reject(new AppError('WALLET_IN_RUN'));
        saved.push(req.settings);
        // like the worker: without trade parameters or groups the current ones stay
        info = {
          ...info,
          settings: {
            ...info.settings,
            ...req.settings,
            trade: req.settings.trade ?? info.settings.trade,
            groups: req.settings.groups ?? info.settings.groups,
          },
        };
        return Promise.resolve({ fileText: '{"saved":true}', info });
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
  return {
    vault,
    saved,
    user: setupUser(),
    endBuy: () => {
      buy = null;
    },
    arm: (on: boolean) => {
      watchArmed = on;
    },
    refuse: (on: boolean) => {
      refuse = on;
    },
  };
}

function row(label: string): HTMLElement {
  const tr = document.querySelector(`input[aria-label="Select ${label}"]`)?.closest('tr');
  if (!tr) throw new Error(`row ${label}`);
  return tr;
}

/** The Slippage badges of a row: buy, then sell. */
function slips(label: string): string[] {
  const r = within(row(label));
  return [
    r.getByTitle('Slippage when buying').textContent,
    r.getByTitle('Slippage when selling').textContent,
  ];
}

/** The planned buy in the summary under the table (BUNNDLY-73). */
function plannedBuy(): string {
  const dt = within(screen.getByLabelText('Fleet summary')).getByText('Planned buy');
  return dt.nextElementSibling?.textContent ?? '';
}

function amount(label: string): HTMLInputElement {
  return within(row(label)).getByLabelText<HTMLInputElement>(`Buy amount ${label}`);
}

async function ready(): Promise<void> {
  await eventually(() => screen.getByText(/^Balances as of /u));
}

/** The mint in the command bar, checked by the worker (BUNNDLY-59). */
async function pasteMint(user: ReturnType<typeof setupUser>): Promise<void> {
  await user.type(screen.getByLabelText(TARGET_LABEL), MINT);
  await screen.findByRole('columnheader', { name: 'Tokens (SPL)' }, TARGET_WAIT);
}

function runEvent(phase: RunEvent['phase']): RunEvent {
  return {
    kind: 'run',
    runId: 1,
    at: 0,
    phase,
    mint: MINT,
    dryRun: true,
    wallets: 2,
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

function walletEvent(index: number, state: WalletEvent['state']): WalletEvent {
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
    times: { orderMs: null, signMs: null, executeMs: null, sinceStartMs: 100 },
  };
}

const GLOBAL = fleetInfo().settings.global;

describe('the buy amount in a row', () => {
  it('leaving the field while its Enter save is on the way saves once (BUNNDLY-76)', async () => {
    const { saved } = setup();
    await ready();
    const field = amount('W01');
    // Enter, then the field is left before the saved value comes back: one change, one save
    fireEvent.change(field, { target: { value: '0,75' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    fireEvent.blur(field);
    await eventually(() => {
      expect(amount('W01').value).toBe('0.75');
    });
    expect(saved).toEqual([
      {
        maxSpend: [{ index: 0, lamports: 750_000_000n }],
        active: [],
        global: GLOBAL,
        trade: DEFAULT_TRADE_SETTINGS,
      },
    ]);
  });

  it('Enter saves the amount of that wallet: SOL in maxSpend, a percent in trade', async () => {
    const { user, saved } = setup();
    await ready();
    await user.type(amount('W01'), '0,75{Enter}');
    await eventually(() => {
      expect(saved).toHaveLength(1);
    });
    // 0.75 SOL = 750 000 000 lamports
    expect(saved[0]).toEqual({
      maxSpend: [{ index: 0, lamports: 750_000_000n }],
      active: [],
      global: GLOBAL,
      trade: DEFAULT_TRADE_SETTINGS,
    });

    await user.click(
      within(row('W02')).getByRole('button', { name: /^Unit of the buy amount W02/u }),
    );
    await user.type(amount('W02'), '40{Enter}');
    await eventually(() => {
      expect(saved).toHaveLength(2);
    });
    // the request tests/worker/trade.test.ts buys with ("the settings the table saves")
    expect(saved[1]).toEqual({
      maxSpend: [{ index: 0, lamports: 750_000_000n }],
      active: [],
      global: GLOBAL,
      trade: { fleet: DEFAULT_TRADE_SETTINGS.fleet, wallets: [{ index: 1, buyPercent: 40 }] },
    });
    // 40 % of the 2 SOL read: 0.8 SOL planned; with W01's 0.75 SOL that is 1.55 SOL
    expect(amount('W02').value).toBe('40');
    expect(plannedBuy()).toBe('1.55 SOL');

    // emptying the field gives the wallet back to the fleet default (none): no entry left
    await user.clear(amount('W01'));
    await user.type(amount('W01'), '{Enter}');
    await eventually(() => {
      expect(saved).toHaveLength(3);
    });
    expect(saved[2]?.maxSpend).toEqual([]);
  });

  it('a SOL amount replaces the percent of the wallet: never both (D-045)', async () => {
    const { user, saved } = setup({
      trade: {
        fleet: DEFAULT_TRADE_SETTINGS.fleet,
        wallets: [{ index: 0, buyPercent: 40, sellPercent: 50 }],
      },
    });
    await ready();
    expect(amount('W01').value).toBe('40');
    await user.click(
      within(row('W01')).getByRole('button', { name: /^Unit of the buy amount W01/u }),
    );
    await eventually(() => {
      expect(saved).toHaveLength(1);
    });
    // "40" now read as SOL: 40 SOL in maxSpend, the percent gone, the sell part kept
    expect(saved[0]?.maxSpend).toEqual([{ index: 0, lamports: 40n * SOL }]);
    expect(saved[0]?.trade?.wallets).toEqual([{ index: 0, sellPercent: 50 }]);
  });

  it('the same value again is not saved again', async () => {
    const { user, saved } = setup({ maxSpend: [{ index: 0, lamports: 500_000_000n }] });
    await ready();
    await user.clear(amount('W01'));
    await user.type(amount('W01'), '0,5{Enter}');
    await user.type(amount('W02'), '{Enter}');
    await act(() => Promise.resolve());
    expect(saved).toEqual([]);
  });

  it('during a buy the fields of its wallets are off; the others and the ones after it are not', async () => {
    const { user, vault, endBuy } = setup({
      maxSpend: [
        { index: 0, lamports: 100_000_000n },
        { index: 1, lamports: 100_000_000n },
      ],
    });
    await ready();
    await pasteMint(user);
    await user.click(screen.getByRole('button', { name: 'Buy' }));
    act(() => {
      vault.emit(runEvent('started'));
      vault.emit(walletEvent(0, 'QUEUED'));
      vault.emit(walletEvent(1, 'QUEUED'));
    });
    await eventually(() => {
      expect(amount('W01').disabled).toBe(true);
    });
    expect(amount('W02').disabled).toBe(true);
    expect(within(row('W01')).getByText(LOCKED)).toBeTruthy();
    expect(
      within(row('W01')).getByRole<HTMLButtonElement>('button', { name: 'Trade settings W01' }),
    ).toBeTruthy();
    // W03 has no amount: it is not in the run and stays editable
    expect(amount('W03').disabled).toBe(false);
    expect(within(row('W03')).queryByText(LOCKED)).toBeNull();

    endBuy();
    act(() => {
      vault.emit(walletEvent(0, 'SKIPPED'));
      vault.emit(walletEvent(1, 'SKIPPED'));
      vault.emit(runEvent('finished'));
    });
    await eventually(() => {
      expect(amount('W01').disabled).toBe(false);
    });
    expect(amount('W02').disabled).toBe(false);
    expect(within(row('W01')).queryByText(LOCKED)).toBeNull();
  });

  it('a wallet with only a percent amount is ready: BUY sends it', async () => {
    const { user, vault } = setup({
      trade: { fleet: DEFAULT_TRADE_SETTINGS.fleet, wallets: [{ index: 2, buyPercent: 10 }] },
    });
    await ready();
    await pasteMint(user);
    // 10 % of the 2 SOL read: 0.2 SOL, not counted from a maxSpend entry (there is none)
    expect(plannedBuy()).toBe('0.2 SOL');
    await user.click(screen.getByRole('button', { name: 'Buy' }));
    await eventually(() => {
      expect(vault.request.mock.calls.map(([r]) => r).find((r) => r.type === 'startBuy')).toEqual({
        type: 'startBuy',
        mint: MINT,
        wallets: [0, 1, 2],
        group: 'g1',
      });
    });
    // only W03 has an amount: its row is the one queued
    // the state chip says it; the Fill caption below says the same stage
    expect(within(row('W03')).getByText('Queued', { selector: ':not(.fill .cap)' })).toBeTruthy();
    expect(within(row('W01')).queryAllByText('Queued')).toEqual([]);
  });

  it('an armed watcher locks every wallet of its group', async () => {
    setup({}, { armed: true });
    await ready();
    await eventually(() => {
      expect(amount('W03').disabled).toBe(true);
    });
    expect(amount('W01').disabled).toBe(true);
  });

  it('WALLET_IN_RUN from the worker puts the saved value back and says why', async () => {
    const { user, saved, refuse } = setup({ maxSpend: [{ index: 0, lamports: 10_000_000n }] });
    await ready();
    refuse(true);
    await user.clear(amount('W01'));
    await user.type(amount('W01'), '0.7{Enter}');
    await eventually(() => {
      expect(within(row('W01')).getByText(LOCKED)).toBeTruthy();
    });
    expect(amount('W01').value).toBe('0.01');
    expect(saved).toEqual([]);
  });
});

describe('the trade settings of one wallet (row edit button)', () => {
  it('2,5 % for the buy side is saved as 250 bps; the sell side keeps its value', async () => {
    const { user, saved } = setup({
      trade: {
        fleet: DEFAULT_TRADE_SETTINGS.fleet,
        wallets: [{ index: 0, sellSlippageBps: 300 }],
      },
    });
    await ready();
    // buy: the fleet default Auto; sell: the wallet's own 3 %
    expect(slips('W01')).toEqual(['Auto', '3 %']);
    expect(within(row('W01')).getByTitle('Priority fee when buying').textContent).toBe('Auto');
    await user.click(within(row('W01')).getByRole('button', { name: 'Trade settings W01' }));
    const pop = screen.getByRole('dialog', { name: 'Trade settings of W01' });
    expect(within(pop).getByRole('heading').textContent).toBe('Trade settings · W01');
    // empty fields keep the values; the placeholders say which
    expect(within(pop).getByLabelText<HTMLInputElement>('Slippage, sell').placeholder).toBe('3 %');
    expect(within(pop).getByLabelText<HTMLInputElement>('Priority fee, buy').disabled).toBe(true);
    expect(within(pop).getByLabelText<HTMLInputElement>('Priority fee, sell').disabled).toBe(true);
    await user.type(within(pop).getByLabelText('Slippage, buy'), '2,5');
    await user.click(within(pop).getByRole('button', { name: 'Apply' }));
    await eventually(() => {
      expect(saved).toHaveLength(1);
    });
    expect(saved[0]?.trade?.wallets).toEqual([
      { index: 0, sellSlippageBps: 300, buySlippageBps: 250 },
    ]);
    expect(saved[0]?.maxSpend).toEqual([]);
    expect(screen.queryByRole('dialog', { name: 'Trade settings of W01' })).toBeNull();
    await eventually(() => {
      expect(slips('W01')).toEqual(['2.5 %', '3 %']);
    });
  });

  it('"Default" gives a value back to the fleet; "Auto" is Auto', async () => {
    const { user, saved } = setup({
      trade: {
        fleet: { ...DEFAULT_TRADE_SETTINGS.fleet, sellSlippageBps: 100 },
        wallets: [{ index: 0, sellSlippageBps: 300, sellPercent: 50 }],
      },
    });
    await ready();
    await user.click(within(row('W01')).getByRole('button', { name: 'Trade settings W01' }));
    const pop = screen.getByRole('dialog', { name: 'Trade settings of W01' });
    await user.type(within(pop).getByLabelText('Slippage, sell'), 'Default');
    await user.type(within(pop).getByLabelText('Slippage, buy'), 'auto');
    await user.click(within(pop).getByRole('button', { name: 'Apply' }));
    await eventually(() => {
      expect(saved).toHaveLength(1);
    });
    // the own 3 % is gone (the fleet's 1 % applies), the sell part stays, Auto is null
    expect(saved[0]?.trade?.wallets).toEqual([{ index: 0, sellPercent: 50, buySlippageBps: null }]);
    await eventually(() => {
      expect(slips('W01')).toEqual(['Auto', '1 %']);
    });
  });

  it('nothing typed, or a slippage out of range, is said in the popover and not saved', async () => {
    const { user, saved } = setup();
    await ready();
    await user.click(within(row('W02')).getByRole('button', { name: 'Trade settings W02' }));
    const pop = screen.getByRole('dialog', { name: 'Trade settings of W02' });
    await user.click(within(pop).getByRole('button', { name: 'Apply' }));
    expect(within(pop).getByRole('alert').textContent).toBe('Fill in at least one value.');
    await user.type(within(pop).getByLabelText('Slippage, buy'), '0,05');
    await user.click(within(pop).getByRole('button', { name: 'Apply' }));
    expect(within(pop).getByRole('alert').textContent).toMatch(
      /^Enter Auto or a slippage from 0\.1 to 100 %/u,
    );
    // Cancel closes without saving
    await user.click(within(pop).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Trade settings of W02' })).toBeNull();
    expect(saved).toEqual([]);
  });
});

describe('Edit selected', () => {
  it('changes only the selected wallets', async () => {
    const { user, saved } = setup({
      maxSpend: [{ index: 1, lamports: 300_000_000n }],
      trade: { fleet: DEFAULT_TRADE_SETTINGS.fleet, wallets: [{ index: 1, sellPercent: 50 }] },
    });
    await ready();
    // W02 is left out (the selection is a draft: it counts before it is saved)
    await user.click(screen.getByRole('checkbox', { name: 'Select W02' }));
    await user.click(screen.getByRole('button', { name: 'Edit selected' }));
    const pop = screen.getByRole('dialog', { name: 'Trade settings of the selected wallets' });
    expect(within(pop).getByRole('heading').textContent).toBe('Trade settings · 2 selected');
    await user.type(within(pop).getByLabelText('Buy amount (SOL)'), '0,2');
    await user.type(within(pop).getByLabelText('Sell part (% of tokens)'), '25');
    await user.click(within(pop).getByRole('button', { name: 'Apply' }));
    await eventually(() => {
      expect(saved).toHaveLength(1);
    });
    expect(saved[0]?.maxSpend).toEqual([
      { index: 0, lamports: 200_000_000n },
      { index: 1, lamports: 300_000_000n },
      { index: 2, lamports: 200_000_000n },
    ]);
    expect(saved[0]?.trade?.wallets).toEqual([
      { index: 0, sellPercent: 25 },
      { index: 1, sellPercent: 50 },
      { index: 2, sellPercent: 25 },
    ]);
  });

  it('a percent amount for the selected wallets goes to trade, not to maxSpend', async () => {
    const { user, saved } = setup({ maxSpend: [{ index: 0, lamports: 300_000_000n }] });
    await ready();
    await user.click(screen.getByRole('button', { name: 'Edit selected' }));
    const pop = screen.getByRole('dialog', { name: 'Trade settings of the selected wallets' });
    await user.click(within(pop).getByRole('button', { name: /^Unit of the buy amount: SOL/u }));
    await user.type(within(pop).getByLabelText('Buy amount (% of balance)'), '10');
    await user.click(within(pop).getByRole('button', { name: 'Apply' }));
    await eventually(() => {
      expect(saved).toHaveLength(1);
    });
    // W01's 0.3 SOL is replaced by the percent: never both (D-045)
    expect(saved[0]?.maxSpend).toEqual([]);
    expect(saved[0]?.trade?.wallets).toEqual([
      { index: 0, buyPercent: 10 },
      { index: 1, buyPercent: 10 },
      { index: 2, buyPercent: 10 },
    ]);
  });

  it('a change of the fleet default reaches the wallets without their own value only', async () => {
    const { user, saved } = setup({
      trade: { fleet: DEFAULT_TRADE_SETTINGS.fleet, wallets: [{ index: 1, buySlippageBps: 100 }] },
    });
    await ready();
    expect([slips('W01'), slips('W02')]).toEqual([
      ['Auto', 'Auto'],
      ['1 %', 'Auto'],
    ]);

    await user.click(screen.getByRole('button', { name: 'Settings' }));
    const buySlip = await screen.findByLabelText('Buy slippage');
    await user.type(buySlip, '3');
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    await eventually(() => {
      expect(saved).toHaveLength(1);
    });
    expect(saved[0]?.trade).toEqual({
      fleet: { ...DEFAULT_TRADE_SETTINGS.fleet, buySlippageBps: 300 },
      wallets: [{ index: 1, buySlippageBps: 100 }],
    });

    // The settings are not in the file yet: leaving Settings asks, and the user goes on.
    await screen.findByRole('button', { name: 'Save the updated fleet file' });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: 'Dashboard' }));
    expect(confirm).toHaveBeenCalledTimes(1);
    confirm.mockRestore();
    await ready();
    expect([slips('W01'), slips('W02'), slips('W03')]).toEqual([
      ['3 %', 'Auto'],
      ['1 %', 'Auto'],
      ['3 %', 'Auto'],
    ]);
  });
});

describe('summary', () => {
  it('first and last fill are each in their own place', () => {
    render(
      <FleetSummaryBar
        summary={{ totalLamports: 0n, toSpendLamports: 0n, readyCount: 0, totalToken: null }}
        walletCount={3}
        selectedCount={3}
        tokenDecimals={null}
        firstFillMs={100}
        lastFillMs={2_500}
      />,
    );
    const dl = screen.getByLabelText('Fleet summary');
    expect(within(dl).getByText('First and last fill').nextElementSibling?.textContent).toBe(
      '+100 ms · +2.5 s',
    );
  });
});
