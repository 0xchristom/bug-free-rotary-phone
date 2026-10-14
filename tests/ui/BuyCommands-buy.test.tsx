// @vitest-environment jsdom
/** BUY from the command bar and the rows (BUNNDLY-59). Setup: BuyCommands.fixture.tsx. */
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TARGET_LABEL, TARGET_WAIT } from './fakes.ts';
import { enter } from './user.ts';
import { MINT, setup, showMint, stateOf } from './BuyCommands.fixture.tsx';

describe('command bar (BUNNDLY-59)', () => {
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
    await enter(user, field, MINT);
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
});
