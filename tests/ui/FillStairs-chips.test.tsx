// @vitest-environment jsdom
/** State chip words of mockup v2, the Tokens estimate and sorting by Fill (BUNNDLY-92, BUNNDLY-94). Setup: FillStairs.fixture.tsx. */
import { act, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { eventually } from './settle.ts';
import {
  setup,
  runEvent,
  walletEvent,
  verifyEvent,
  showMint,
  fillOf,
  chipOf,
  chipEl,
  cellOf,
  rowOrder,
} from './FillStairs.fixture.tsx';

describe('state chip words of mockup v2 (BUNNDLY-94)', () => {
  it('Filled only for a buy the Filled tab counts; Bought before or against the chain read', async () => {
    const { vault, user } = setup({ dryRun: false });
    await showMint(user);
    act(() => {
      vault.emit(runEvent('started', false));
      for (const i of [0, 1, 2]) vault.emit(walletEvent(i, 'CONFIRMED'));
    });
    // CONFIRMED by Jupiter, no chain read yet: not in the Filled tab, so not "Filled"
    await eventually(() => {
      expect(chipOf('W01')).toEqual({ text: 'Bought', tone: 'ok' });
    });
    act(() => {
      vault.emit(verifyEvent(0, 'MATCH'));
      vault.emit(verifyEvent(1, 'INCREASED'));
      vault.emit(verifyEvent(2, 'MISMATCH'));
    });
    await eventually(() => {
      expect(chipOf('W01')).toEqual({ text: 'Filled', tone: 'ok' });
    });
    expect(chipOf('W02')).toEqual({ text: 'Filled', tone: 'ok' });
    expect(chipOf('W03')).toEqual({ text: 'Bought', tone: 'ok' });
    // the rows that say Filled are the rows of the Filled tab
    await user.click(
      within(screen.getByRole('group', { name: 'Wallet filters' })).getByRole('button', {
        name: /^Filled \d+$/u,
      }),
    );
    expect(screen.queryByRole('progressbar', { name: 'Fill of W01' })).not.toBeNull();
    expect(screen.queryByRole('progressbar', { name: 'Fill of W02' })).not.toBeNull();
    expect(screen.queryByRole('progressbar', { name: 'Fill of W03' })).toBeNull();
  });

  it('a DRY-RUN skip says Simulated in the sim tone', async () => {
    const { vault, user } = setup({ dryRun: true });
    await showMint(user);
    act(() => {
      vault.emit(runEvent('started', true));
      vault.emit(
        walletEvent(0, 'SKIPPED', { reason: { kind: 'SKIPPED', code: 'DRY_RUN', detail: null } }),
      );
    });
    await eventually(() => {
      expect(chipOf('W01')).toEqual({ text: 'Simulated', tone: 'sim' });
    });
  });

  it('Scheduled has a clock instead of the running dot; its text stays', async () => {
    const { vault, user } = setup({ dryRun: false });
    await showMint(user);
    act(() => {
      vault.emit(runEvent('started', false));
      vault.emit(walletEvent(0, 'QUEUED', { attempt: 0 }));
      vault.emit(walletEvent(1, 'SCHEDULED', { scheduledAt: 0 }));
    });
    await eventually(() => {
      expect(chipOf('W02').text).toBe('Scheduled');
    });
    expect(chipEl('W02').querySelector('svg.k-i')?.getAttribute('aria-hidden')).toBe('true');
    expect(chipEl('W02').querySelector('.k-dot')).toBeNull();
    // a running wallet keeps its dot and has no icon
    expect(chipEl('W01').querySelector('.k-dot')).not.toBeNull();
    expect(chipEl('W01').querySelector('svg')).toBeNull();
  });
});

describe('Tokens estimate and Fill sorting (BUNNDLY-92)', () => {
  // 0.01 SOL quoted for 1 234.5 tokens (6 decimals): 1_234_500_000 base units
  const quote = { inAmount: 10_000_000n, outAmount: 1_234_500_000n, router: 'test' };

  it('DRY-RUN: Tokens says the quote with ≈, the chain balance (0) is not shown as bought', async () => {
    const { vault, user } = setup({ dryRun: true });
    await showMint(user);
    expect(cellOf('W01', 'Tokens (SPL)')).toBe('0');
    act(() => {
      vault.emit(runEvent('started', true));
      vault.emit(
        walletEvent(0, 'SKIPPED', {
          quote,
          reason: { kind: 'SKIPPED', code: 'DRY_RUN', detail: null },
        }),
      );
      vault.emit(walletEvent(1, 'QUEUED', { attempt: 0 }));
    });
    await eventually(() => {
      expect(cellOf('W01', 'Tokens (SPL)')).toBe('≈ 1234.5');
    });
    // no quote yet: the chain balance, without ≈
    expect(cellOf('W02', 'Tokens (SPL)')).toBe('0');
  });

  it('live: Tokens stays the chain balance even with a quote', async () => {
    const { vault, user } = setup({ dryRun: false });
    await showMint(user);
    act(() => {
      vault.emit(runEvent('started', false));
      vault.emit(walletEvent(0, 'SIGNING', { quote }));
    });
    await eventually(() => {
      expect(fillOf('W01')).toEqual({ now: '35', text: '35%, Signing' });
    });
    expect(cellOf('W01', 'Tokens (SPL)')).toBe('0');
  });

  it('Fill sorts the fullest first, then the other way; a click on the header', async () => {
    const { vault, user } = setup({ dryRun: false });
    await showMint(user);
    act(() => {
      vault.emit(runEvent('started', false));
      vault.emit(walletEvent(0, 'QUOTING')); // 20
      vault.emit(walletEvent(1, 'SUBMITTED')); // 60
      vault.emit(walletEvent(2, 'QUEUED', { attempt: 0 })); // 5
    });
    await eventually(() => {
      expect(fillOf('W02').now).toBe('60');
    });
    expect(rowOrder()).toEqual(['W01', 'W02', 'W03']);
    const header = screen.getByRole('columnheader', { name: 'Fill' });
    await user.click(within(header).getByRole('button', { name: 'Fill' }));
    expect(rowOrder()).toEqual(['W02', 'W01', 'W03']);
    expect(header.getAttribute('aria-sort')).toBe('descending');
    await user.click(within(header).getByRole('button', { name: 'Fill' }));
    expect(rowOrder()).toEqual(['W03', 'W01', 'W02']);
    expect(header.getAttribute('aria-sort')).toBe('ascending');
  });
});
