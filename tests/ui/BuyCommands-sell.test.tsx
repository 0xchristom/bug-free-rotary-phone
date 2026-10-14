// @vitest-environment jsdom
/** SELL from the command bar and the rows, and a creator as the target (BUNNDLY-59, BUNNDLY-73). Setup: BuyCommands.fixture.tsx. */
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TARGET_LABEL, TARGET_WAIT } from './fakes.ts';
import { eventually } from './settle.ts';
import { enter } from './user.ts';
import { MINT, CREATOR, setup, showMint, stateOf } from './BuyCommands.fixture.tsx';

describe('command bar (BUNNDLY-59)', () => {
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
    await eventually(() => screen.getByText(/^Slot \S+ · /u));
    const sell = (): HTMLElement => screen.getByRole('button', { name: 'Sell W03' });
    expect(sell()).toHaveProperty('disabled', true);
    expect(sell().getAttribute('aria-description')).toBe('Paste the mint of the token to sell.');
    await enter(user, screen.getByLabelText(TARGET_LABEL), MINT);
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
    await enter(user, field, MINT);
    await screen.findByText('Token · SPL', {}, TARGET_WAIT);
    // focus off the field, on the page itself
    await user.click(document.body);
    await user.keyboard('s');
    expect(requests.filter((r) => r.type === 'startSell')).toHaveLength(1);
    // BUNNDLY-90: the count is the one the worker answers (the fake answers 3), DRY-RUN said
    await waitFor(() => {
      expect(screen.getByRole('status', { name: 'Last command' }).textContent).toBe(
        'Sell started on 3 wallets · Immediate · DRY-RUN',
      );
    });
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
    await eventually(() => screen.getByText(/^Slot \S+ · /u));
    const sell = (): HTMLElement => screen.getByRole('button', { name: 'Sell' });
    expect(sell()).toHaveProperty('disabled', true);
    expect(sell().getAttribute('aria-description')).toBe('Paste the mint of the token to sell.');
    await enter(user, screen.getByLabelText(TARGET_LABEL), MINT);
    await screen.findByText('Token · SPL', {}, TARGET_WAIT);
    expect(sell()).toHaveProperty('disabled', false);
    await user.click(screen.getByRole('checkbox', { name: 'Select all wallets' }));
    expect(sell().getAttribute('aria-description')).toBe('Select the wallets that sell.');
  });

  it('a creator wallet as the target: BUY waits for that creator’s token', async () => {
    const { user } = setup();
    await screen.findByText(/^Slot \S+ · /u);
    await enter(user, screen.getByLabelText(TARGET_LABEL), CREATOR);
    await screen.findByText('Creator wallet', {}, TARGET_WAIT);
    const buy = screen.getByRole('button', { name: 'Buy' });
    expect(buy).toHaveProperty('disabled', true);
    expect(buy.getAttribute('aria-description')).toBe(
      'BUY needs a token: arm the watcher and wait for this creator’s token, or paste a mint.',
    );
  });
});
