// @vitest-environment jsdom
/**
 * Wallet groups on the fleet screen (BUNNDLY-69): tabs with each group's wallets, SOL and
 * state from the worker; the command bar acts on the shown group; group changes go to the
 * worker as `saveSettings.groups`.
 */
import { act, cleanup, render, screen, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { WalletGroupV1 } from '../../src/core/groups.ts';
import { App } from '../../src/ui/App.tsx';
import type { WatchStatus } from '../../src/watcher/watch.ts';
import type { BuyStatus, VaultInfo, VaultRequest, VaultStatus } from '../../src/worker/protocol.ts';
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

const MINT = SPL_MINT;

interface Run {
  buy: BuyStatus | null;
  watch: WatchStatus | null;
}

interface Setup {
  readonly groups?: readonly WalletGroupV1[];
  readonly dryRun?: boolean;
  /** The worker's state per group id at the start. */
  readonly runs?: Readonly<Record<string, Partial<Run>>>;
}

function watching(): WatchStatus {
  return {
    creator: 'Creator1111111111111111111111111111111111111',
    armedAt: '2026-10-14T09:00:00.000Z',
    mode: 'one-shot',
    armed: true,
    connection: 'connected',
    attempt: 0,
    lastMessageAt: null,
    detections: [],
    queued: [],
  };
}

function running(mint: string, side: 'buy' | 'sell' = 'buy', accepting = true): BuyStatus {
  return { side, runId: 7, mint, dryRun: true, wallets: 2, accepting };
}

/**
 * 8 wallets. Wallet i holds 1.i SOL (1 SOL + i × 0.1 SOL) and may spend (i + 1) × 0.01 SOL,
 * so every sum in these tests can be added up by hand.
 */
function setup({ groups = [], dryRun = true, runs = {} }: Setup = {}) {
  const base = fleetInfo(8);
  let info: VaultInfo = {
    ...base,
    settings: {
      ...base.settings,
      maxSpend: base.wallets.map((w) => ({
        index: w.index,
        lamports: BigInt(w.index + 1) * 10_000_000n,
      })),
      global: { ...base.settings.global, dryRun },
      groups,
    },
    apiKeys: { ...base.apiKeys, helius: true },
  };
  const state = new Map<string, Run>(
    Object.entries(runs).map(([id, r]) => [id, { buy: r.buy ?? null, watch: r.watch ?? null }]),
  );
  const runOf = (id: string): Run => {
    let run = state.get(id);
    if (!run) {
      run = { buy: null, watch: null };
      state.set(id, run);
    }
    return run;
  };
  const ids = (): string[] =>
    info.settings.groups.length > 0 ? info.settings.groups.map((g) => g.id) : ['g1'];
  const status = (): VaultStatus => {
    const list = ids().map((id) => {
      const r = runOf(id);
      return { id, armed: r.buy !== null || r.watch?.armed === true, buy: r.buy, watch: r.watch };
    });
    return {
      locked: false,
      network: 'mainnet',
      armed: list.some((g) => g.armed),
      info,
      buy: list.find((g) => g.buy)?.buy ?? null,
      watch: list.find((g) => g.watch)?.watch ?? null,
      groups: list,
    };
  };
  const vault = mockVault(status());
  const requests: VaultRequest[] = [];
  let runId = 10;
  vault.request.mockImplementation((req: VaultRequest) => {
    requests.push(req);
    switch (req.type) {
      case 'status':
      case 'activity':
        return Promise.resolve(status());
      case 'refreshBalances':
        return Promise.resolve({
          balances: info.wallets.map((w) => ({
            index: w.index,
            lamports: 1_000_000_000n + BigInt(w.index) * 100_000_000n,
          })),
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
          network: 'mainnet',
          source: 'helius',
          fetchedAt: '2026-10-14T09:00:00.000Z',
        });
      case 'classifyTarget':
        return classifyFake(req.address);
      case 'startBuy': {
        runId += 1;
        const buy = {
          runId,
          mint: req.mint,
          dryRun,
          wallets: req.wallets?.length ?? 0,
          accepting: true,
        };
        runOf(req.group ?? 'g1').buy = buy;
        return Promise.resolve(buy);
      }
      case 'stop': {
        const r = runOf(req.group ?? 'g1');
        if (r.buy) r.buy = { ...r.buy, accepting: false };
        return Promise.resolve(status());
      }
      case 'saveSettings':
        info = { ...info, settings: { ...info.settings, ...req.settings } };
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
  return { requests, user: setupUser() };
}

const TWO_GROUPS: readonly WalletGroupV1[] = [
  { id: 'g1', name: 'Team A', wallets: [0, 1, 2, 3, 4] },
  { id: 'g2', name: 'Team B', wallets: [5, 6, 7] },
];

const THREE_GROUPS: readonly WalletGroupV1[] = [
  { id: 'g1', name: 'Team A', wallets: [0, 1, 2] },
  { id: 'g2', name: 'Team B', wallets: [3, 4, 5] },
  { id: 'g3', name: 'Team C', wallets: [6, 7] },
];

function groupTab(name: string): HTMLElement {
  return within(screen.getByRole('group', { name: 'Wallet groups' })).getByRole('button', {
    name: new RegExp(`^${name}\\b`, 'u'),
  });
}

/** What a group tab says: wallet count, SOL sum and state. */
function tabText(name: string): { count: string; sol: string; state: string } {
  const tab = groupTab(name);
  return {
    count: tab.querySelector('.tab-count')?.textContent ?? '',
    sol: tab.querySelector('.tab-sol')?.textContent ?? '',
    state: tab.querySelector('.k-chip')?.textContent ?? '',
  };
}

async function ready(): Promise<void> {
  await eventually(() => screen.getByText(/^Slot \S+ · /u));
}

async function typeMint(user: UserEvent): Promise<void> {
  // these tests send to every wallet at once; Stairs is the default since BUNNDLY-93
  await user.click(screen.getByRole('button', { name: 'Immediate' }));
  await user.type(screen.getByLabelText(TARGET_LABEL), MINT);
  await screen.findByRole('columnheader', { name: 'Tokens (SPL)' }, TARGET_WAIT);
}

function sent<T extends VaultRequest['type']>(
  requests: readonly VaultRequest[],
  type: T,
): Extract<VaultRequest, { type: T }>[] {
  return requests.filter((r): r is Extract<VaultRequest, { type: T }> => r.type === type);
}

describe('wallet groups (BUNNDLY-69)', () => {
  it('8 wallets: 3 selected move to a new group; the request carries exactly them', async () => {
    const { user, requests } = setup();
    await ready();
    // one group of all 8 at first: no group tabs, as in the mockup (BUNNDLY-73)
    expect(screen.queryByRole('group', { name: 'Wallet groups' })).toBeNull();
    await user.click(screen.getByRole('checkbox', { name: 'Select all wallets' }));
    for (const label of ['W02', 'W05', 'W07']) {
      await user.click(screen.getByRole('checkbox', { name: `Select ${label}` }));
    }
    await user.click(screen.getByRole('button', { name: 'Move to group' }));
    await user.click(screen.getByRole('button', { name: 'New group…' }));
    await user.type(screen.getByLabelText('New group for 3 wallets'), 'Team B');
    await user.click(screen.getByRole('button', { name: 'Create and move' }));
    await eventually(() => groupTab('Team B'));
    expect(sent(requests, 'saveSettings').map((r) => r.settings.groups)).toEqual([
      [
        { id: 'g1', name: 'All wallets', wallets: [0, 2, 3, 5, 7] },
        { id: 'g2', name: 'Team B', wallets: [1, 4, 6] },
      ],
    ]);
    // W02, W05, W07: 1.1 + 1.4 + 1.6 = 4.1 SOL
    expect(tabText('Team B')).toEqual({ count: '3', sol: '4.1 SOL', state: 'Idle' });
    // the rest: 1.0 + 1.2 + 1.3 + 1.5 + 1.7 = 6.7 SOL
    expect(tabText('All wallets')).toEqual({ count: '5', sol: '6.7 SOL', state: 'Idle' });
    await user.click(groupTab('Team B'));
    expect(
      screen
        .getAllByRole('checkbox', { name: /^Select W/u })
        .map((c) => c.getAttribute('aria-label')),
    ).toEqual(['Select W02', 'Select W05', 'Select W07']);
  });

  it('BUY in A sends A and its wallets; B stays Idle and buys on its own; STOP stops A only', async () => {
    const { user, requests } = setup({ groups: TWO_GROUPS });
    await ready();
    await typeMint(user);
    await user.click(screen.getByRole('button', { name: 'Buy' }));
    expect(sent(requests, 'startBuy')).toEqual([
      { type: 'startBuy', mint: MINT, wallets: [0, 1, 2, 3, 4], group: 'g1' },
    ]);
    await eventually(() => {
      expect(tabText('Team A').state).toBe('Buying');
    });
    expect(tabText('Team B').state).toBe('Idle');

    await user.click(groupTab('Team B'));
    // B has its own, empty target; switching did not stop A
    expect(screen.getByLabelText<HTMLInputElement>(TARGET_LABEL).value).toBe('');
    expect(sent(requests, 'stop')).toEqual([]);
    await typeMint(user);
    expect(screen.getByRole('button', { name: 'Buy' })).toHaveProperty('disabled', false);
    await user.click(screen.getByRole('button', { name: 'Buy' }));
    expect(sent(requests, 'startBuy').at(-1)).toEqual({
      type: 'startBuy',
      mint: MINT,
      wallets: [5, 6, 7],
      group: 'g2',
    });

    await user.click(groupTab('Team A'));
    expect(screen.getByLabelText<HTMLInputElement>(TARGET_LABEL).value).toBe(MINT);
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(sent(requests, 'stop')).toEqual([{ type: 'stop', group: 'g1' }]);
    await eventually(() => {
      expect(tabText('Team A').state).toBe('Stopped');
    });
    expect(tabText('Team B').state).toBe('Buying');
  });

  it('in "All" a row buys in its own group, not in the shown tab', async () => {
    const { user, requests } = setup({ groups: TWO_GROUPS });
    await ready();
    await user.click(groupTab('All'));
    expect(screen.getByRole('columnheader', { name: 'Group' })).toBeTruthy();
    // with two groups the bar's commands wait for a tab
    expect(screen.getByRole('button', { name: 'Buy' })).toHaveProperty('disabled', true);
    await typeMint(user);
    await user.click(screen.getByRole('button', { name: 'Buy W07' }));
    expect(sent(requests, 'startBuy')).toEqual([
      { type: 'startBuy', mint: MINT, wallets: [6], group: 'g2' },
    ]);
  });

  it('a running group keeps its wallets, name and row buys; another group can change', async () => {
    const { user, requests } = setup({
      groups: THREE_GROUPS,
      runs: { g2: { buy: running(MINT) } },
    });
    await ready();
    await eventually(() => {
      expect(tabText('Team B').state).toBe('Buying');
    });

    await user.click(groupTab('Team B'));
    const why = 'Team B is running: wait for it to end or press STOP.';
    // Rename and Delete are in the shown group's menu (BUNNDLY-73)
    await user.click(screen.getByRole('button', { name: 'Group actions: Team B' }));
    for (const name of ['Move to group', 'Rename', 'Delete group']) {
      const button = screen.getByRole('button', { name });
      expect(button).toHaveProperty('disabled', true);
      expect(button.getAttribute('aria-description')).toBe(why);
    }
    await user.keyboard('{Escape}');
    const rowBuy = screen.getByRole('button', { name: 'Buy W04' });
    expect(rowBuy).toHaveProperty('disabled', true);
    expect(rowBuy.getAttribute('aria-description')).toBe(why);
    // The amount locks only for the wallets of the run itself (D-050); this run has no rows yet.
    expect(screen.getByLabelText('Buy amount W04')).toHaveProperty('disabled', false);

    await user.click(groupTab('Team C'));
    // C's row buy waits only for a mint, not for the running B
    expect(screen.getByRole('button', { name: 'Buy W07' }).getAttribute('aria-description')).toBe(
      'Paste a token mint first.',
    );
    // C's wallets cannot go into the running B, but B is no reason to keep C from changing.
    // Only the selected W07 moves; W08 stays and goes to A when C is deleted.
    await user.click(screen.getByRole('checkbox', { name: 'Select W08' }));
    await user.click(screen.getByRole('button', { name: 'Move to group' }));
    const move = screen.getByRole('dialog', { name: 'Move to group' });
    expect(within(move).getByRole('button', { name: 'Team B' })).toHaveProperty('disabled', true);
    expect(within(move).getByRole('button', { name: 'Team A' })).toHaveProperty('disabled', false);
    await user.click(within(move).getByRole('button', { name: 'Team A' }));
    await eventually(() => {
      expect(tabText('Team C').count).toBe('1');
    });

    await user.click(screen.getByRole('button', { name: 'Group actions: Team C' }));
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    const field = screen.getByLabelText('New name for Team C');
    await user.clear(field);
    await user.type(field, 'Team Z');
    await user.click(
      within(screen.getByRole('dialog', { name: 'Rename group' })).getByRole('button', {
        name: 'Rename',
      }),
    );
    await eventually(() => groupTab('Team Z'));

    await user.click(screen.getByRole('button', { name: 'Group actions: Team Z' }));
    await user.click(screen.getByRole('button', { name: 'Delete group' }));
    await user.click(
      within(screen.getByRole('dialog', { name: 'Delete group' })).getByRole('button', {
        name: 'Delete',
      }),
    );
    await eventually(() => {
      expect(screen.queryByRole('button', { name: /^Team Z\b/u })).toBeNull();
    });
    expect(sent(requests, 'saveSettings').map((r) => r.settings.groups)).toEqual([
      [
        { id: 'g1', name: 'Team A', wallets: [0, 1, 2, 6] },
        { id: 'g2', name: 'Team B', wallets: [3, 4, 5] },
        { id: 'g3', name: 'Team C', wallets: [7] },
      ],
      [
        { id: 'g1', name: 'Team A', wallets: [0, 1, 2, 6] },
        { id: 'g2', name: 'Team B', wallets: [3, 4, 5] },
        { id: 'g3', name: 'Team Z', wallets: [7] },
      ],
      [
        { id: 'g1', name: 'Team A', wallets: [0, 1, 2, 6, 7] },
        { id: 'g2', name: 'Team B', wallets: [3, 4, 5] },
      ],
    ]);
  });

  it('the tabs show the state the worker reports for each group', async () => {
    setup({
      groups: [
        ...THREE_GROUPS,
        { id: 'g4', name: 'Team D', wallets: [] },
        { id: 'g5', name: 'Team E', wallets: [] },
      ],
      runs: {
        g1: { watch: watching() },
        g2: { buy: running(MINT, 'sell') },
        g3: { buy: running(MINT, 'buy', false) },
        g4: { buy: running(MINT) },
        g5: { watch: { ...watching(), armed: false } },
      },
    });
    await ready();
    await eventually(() => {
      expect(
        ['Team A', 'Team B', 'Team C', 'Team D', 'Team E'].map((n) => tabText(n).state),
      ).toEqual(['Armed', 'Selling', 'Stopped', 'Buying', 'Idle']);
    });
  });

  it('live: the dialog names the group, its wallet count and the SOL it may spend', async () => {
    const { user, requests } = setup({ groups: TWO_GROUPS, dryRun: false });
    await ready();
    await user.click(groupTab('Team B'));
    await typeMint(user);
    await user.click(screen.getByRole('button', { name: 'Buy' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Buy in live mode?' });
    const value = (term: string): string =>
      within(dialog).getByText(term).nextElementSibling?.textContent ?? '';
    expect(value('Group')).toBe('Team B');
    expect(value('Wallets')).toBe('3');
    // W06, W07, W08 may spend 0.06 + 0.07 + 0.08 SOL
    expect(value('Total to spend')).toBe('up to 0.21 SOL');
    expect(sent(requests, 'startBuy')).toEqual([]);
    await act(async () => {
      within(dialog).getByRole('button', { name: 'Yes, buy' }).click();
      await Promise.resolve();
    });
    expect(sent(requests, 'startBuy')).toEqual([
      { type: 'startBuy', mint: MINT, wallets: [5, 6, 7], group: 'g2' },
    ]);
  });
});
