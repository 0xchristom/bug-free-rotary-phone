// @vitest-environment jsdom
/** Buying on the fleet screen (BUNNDLY-27): a full run, the bought mint's decimals, Jupiter limits, DRY-RUN and live mode, explorer links. Setup: BuyCommands.fixture.tsx. */
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TARGET_LABEL, TARGET_WAIT, TOKEN_2022_MINT } from './fakes.ts';
import {
  MINT,
  SIG,
  setup,
  runEvent,
  walletEvent,
  showMint,
  row,
  tabCount,
  goTo,
  summaryValue,
  SIG_SHORT,
} from './BuyCommands.fixture.tsx';

describe('mode A', () => {
  it('BUY only with a mint the worker checked and a ready wallet', async () => {
    const { user, requests } = setup();
    await screen.findByText(/^Slot \S+ · /u);
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
    await screen.findByText(/^Slot \S+ · /u);
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
    expect(row('W01').querySelector('.c-status .k-chip')?.textContent).toBe('Filled');
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

describe('Jupiter limits in Settings', () => {
  it('shows the plan that applies: Keyless without a key, the Settings plan with one', async () => {
    const first = setup();
    await screen.findByText(/^Slot \S+ · /u);
    await goTo(first.user, 'Settings');
    expect(screen.getByLabelText('Jupiter limit for buys').textContent).toBe(
      'Buys use now: No key (Keyless), 30 /order per minute (no Jupiter API key saved).',
    );
    cleanup();
    const second = setup({ jupiterKey: true });
    await screen.findByText(/^Slot \S+ · /u);
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
    await screen.findByText(/^Slot \S+ · /u);
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
    await screen.findByText(/^Slot \S+ · /u);
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
