// @vitest-environment jsdom
/** The fleet table at 100 wallets, the summary, filters, search and sorting. Setup: FleetTable.fixture.tsx. */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TARGET_LABEL, TARGET_WAIT, TOKEN_2022_MINT, fleetInfo } from './fakes.ts';
import {
  SOL,
  BALANCE,
  setup,
  ready,
  cells,
  selectBox,
  headerBox,
  summaryValue,
} from './FleetTable.fixture.tsx';

describe('100 wallets', () => {
  it('a balance refresh re-renders only the rows whose balance changed', async () => {
    const renders = new Map<number, number>();
    const probe = (index: number): void => {
      renders.set(index, (renders.get(index) ?? 0) + 1);
    };
    const { user, setBalances } = setup({ count: 100, probe });
    await ready();
    await waitFor(() => {
      expect(cells('W100')[BALANCE]).toBe('1');
    });
    expect(renders.size).toBe(100);
    const before = new Map(renders);

    // same balances: no row renders again
    await user.click(screen.getByRole('button', { name: /^Fleet balance:/u }));
    await act(() => Promise.resolve());
    expect(renders).toEqual(before);

    // one wallet changed: only that row renders, once
    setBalances((i) => (i === 42 ? 2n * SOL : SOL));
    await user.click(screen.getByRole('button', { name: /^Fleet balance:/u }));
    // 1 SOL before, 2 after: "+1" under it, written on the element, not a second render
    await waitFor(() => {
      expect(cells('W43')[BALANCE]).toBe('2+1');
    });
    const changed = [...renders].filter(([i, n]) => n !== before.get(i)).map(([i]) => i);
    expect(changed).toEqual([42]);
    expect(renders.get(42)).toBe((before.get(42) ?? 0) + 1);
  }, 30_000);

  it('a filter or a search that keeps a row on screen does not render it again', async () => {
    const renders = new Map<number, number>();
    const probe = (index: number): void => {
      renders.set(index, (renders.get(index) ?? 0) + 1);
    };
    const { user } = setup({ count: 100, probe });
    await ready();
    await waitFor(() => {
      expect(cells('W100')[BALANCE]).toBe('1');
    });
    renders.clear();
    // every wallet is selected: the Selected tab shows the same 100 rows
    fireEvent.click(document.querySelector('.tabs button:nth-child(2)') ?? document.body);
    expect(document.querySelectorAll('tbody tr')).toHaveLength(100);
    expect(renders.size).toBe(0);
    // W10 and W100 match "W10": the other rows leave, these two stay without a render
    const search = document.querySelector<HTMLInputElement>('input[type="search"]');
    if (!search) throw new Error('search');
    await user.type(search, 'W10');
    expect(document.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(renders.size).toBe(0);
  }, 30_000);
});

describe('summary', () => {
  it('the summary sums token balances with decimals', async () => {
    const { user } = setup();
    await ready();
    expect(summaryValue('Tokens held')).toBe('—');
    await user.type(screen.getByLabelText(TARGET_LABEL), TOKEN_2022_MINT);
    await screen.findByRole('columnheader', { name: 'Tokens (Token-2022)' }, TARGET_WAIT);
    expect(summaryValue('Tokens held')).toBe('4.5'); // 0 + 1.5 + 3
  });
});

describe('filters, search and sorting (mockup v2)', () => {
  /** Wallet labels in the order the table shows them. */
  function shownLabels(): string[] {
    return [...document.querySelectorAll('tbody tr .w-name')].map((b) => b.textContent);
  }

  it('the tabs count their wallets; Selected shows only the selected ones', async () => {
    const { user } = setup({ settings: { active: [{ index: 1, active: false }] } });
    await ready();
    const tabs = within(screen.getByRole('group', { name: 'Wallet filters' }));
    expect(tabs.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'All wallets 3',
      'Selected 2',
      'In flight 0',
      'Filled 0',
      'Needs attention 0',
    ]);
    await user.click(tabs.getByRole('button', { name: 'Selected 2' }));
    expect(tabs.getByRole('button', { name: 'Selected 2' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(shownLabels()).toEqual(['W01', 'W03']);
    await user.click(tabs.getByRole('button', { name: 'Needs attention 0' }));
    expect(shownLabels()).toEqual([]);
    expect(screen.getByText('No wallet matches the filter.')).toBeTruthy();
  });

  it('a too small reserve puts the wallet under Needs attention', async () => {
    setup({ settings: { maxSpend: [{ index: 2, lamports: 990_000_000n }] } });
    await ready();
    // 1 SOL − 0.99 SOL = 0.01 SOL < 0.015 SOL
    expect(screen.getByRole('button', { name: 'Needs attention 1' })).toBeTruthy();
  });

  it('the search finds a wallet by its name or its address', async () => {
    const { user } = setup();
    await ready();
    const search = screen.getByRole('searchbox', { name: 'Search wallets' });
    await user.type(search, 'w02');
    expect(shownLabels()).toEqual(['W02']);
    await user.clear(search);
    await user.type(search, 'Address2'); // the address of the third wallet
    expect(shownLabels()).toEqual(['W03']);
    await user.clear(search);
    expect(shownLabels()).toEqual(['W01', 'W02', 'W03']);
  });

  it('a click on Balance sorts the largest first, a second click turns it round', async () => {
    const { user } = setup({ lamports: (i) => [2n * SOL, 3n * SOL, SOL][i] ?? 0n });
    await ready();
    const header = screen.getByRole('columnheader', { name: 'Balance (SOL)' });
    expect(header.getAttribute('aria-sort')).toBe('none');
    await user.click(within(header).getByRole('button'));
    expect(header.getAttribute('aria-sort')).toBe('descending');
    expect(shownLabels()).toEqual(['W02', 'W01', 'W03']);
    await user.click(within(header).getByRole('button'));
    expect(header.getAttribute('aria-sort')).toBe('ascending');
    expect(shownLabels()).toEqual(['W03', 'W01', 'W02']);
  });

  it('a click on Buy amount sorts by what a buy would spend, empty ones last', async () => {
    const { user } = setup({
      lamports: () => 2n * SOL,
      settings: {
        maxSpend: [{ index: 2, lamports: 100_000_000n }],
        trade: {
          fleet: fleetInfo().settings.trade.fleet,
          // 2 % of 2 SOL = 0.04 SOL: between the other two
          wallets: [{ index: 0, buyPercent: 2 }],
        },
      },
    });
    await ready();
    const header = screen.getByRole('columnheader', { name: 'Buy amount (SOL or % of balance)' });
    await user.click(within(header).getByRole('button'));
    expect(shownLabels()).toEqual(['W03', 'W01', 'W02']);
  });

  it('the header checkbox selects only the wallets the filter and the search show', async () => {
    const { user } = setup();
    await ready();
    await user.type(screen.getByRole('searchbox', { name: 'Search wallets' }), 'W02');
    expect(headerBox().checked).toBe(true);
    // the count is of the whole fleet, not of what the search shows
    expect(screen.getByText('3 of 3 selected')).toBeTruthy();
    await user.click(headerBox()); // clears W02 only
    await user.clear(screen.getByRole('searchbox', { name: 'Search wallets' }));
    expect(['W01', 'W02', 'W03'].map((l) => selectBox(l).checked)).toEqual([true, false, true]);
    expect(screen.getByText('2 of 3 selected')).toBeTruthy();
  });
});
