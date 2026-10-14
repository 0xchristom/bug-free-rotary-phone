// @vitest-environment jsdom
/** Render counts of the fleet screen at 100 wallets. Setup: BuyCommands.fixture.tsx. */
import { act, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TARGET_LABEL, TARGET_WAIT } from './fakes.ts';
import { eventually } from './settle.ts';
import { MINT, setup, runEvent, walletEvent, part } from './BuyCommands.fixture.tsx';

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
    await eventually(() => screen.getByText(/^Slot \S+ · /u));
    // every wallet at once; Stairs is the default since BUNNDLY-93
    await user.click(within(part('.table-bar')).getByRole('button', { name: 'Immediate' }));
    const bar = within(part('section.target'));
    await user.click(bar.getByLabelText(TARGET_LABEL));
    await user.paste(MINT);
    await screen.findByRole('columnheader', { name: 'Tokens (SPL)' }, TARGET_WAIT);
    await user.click(within(part('.table-bar')).getByRole('button', { name: 'Buy' }));
    const panel = within(part('dl.summary'));
    renders.clear();
    act(() => {
      vault.emit(runEvent('started', 100));
      for (let i = 0; i < 100; i++) vault.emit(walletEvent(i, 'QUEUED'));
    });
    // The rows clicked are shown queued at once, so the fleet fill says "100 in flight"
    // before the events arrive (and since BUNNDLY-93 it is there before any run): wait for
    // the frame of the events, in which every row takes its own event.
    await eventually(() => {
      expect(renders.size).toBe(100);
    });
    expect(panel.getByText(/Fleet fill · 0 of 100 filled · 100 in flight/u)).toBeTruthy();
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
