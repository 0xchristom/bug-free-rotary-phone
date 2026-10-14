// @vitest-environment jsdom
/** Stairs in the toolbar (BUNNDLY-61 part 2). Setup: FillStairs.fixture.tsx. */
import { act, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { eventually } from './settle.ts';
import {
  MINT,
  setup,
  runEvent,
  walletEvent,
  showMint,
  fillOf,
  said,
  toolbar,
} from './FillStairs.fixture.tsx';

describe('Stairs in the toolbar (BUNNDLY-61 part 2)', () => {
  // BUNNDLY-93: Stairs is the default, every 6 s, 1 wallet per step (Andy's interim decision)
  it('Stairs by default, every 6 s and 1 per step, with the plan; BUY sends the steps', async () => {
    const { requests, user } = setup();
    await showMint(user);
    const bar = within(toolbar());
    expect(bar.getByRole('button', { name: 'Stairs' }).getAttribute('aria-pressed')).toBe('true');
    expect(bar.getByRole('button', { name: 'Immediate' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
    expect(bar.getByLabelText<HTMLInputElement>('Seconds between steps').value).toBe('6');
    expect(bar.getByLabelText<HTMLInputElement>('Wallets per step').value).toBe('1');
    // 3 selected, every 6 s, 1 per step: 3 steps, the last one 2 × 6 s = 12 s after the first
    expect(screen.getByTestId('stairs-plan').textContent).toBe('→ 3 steps, last one at +12.0 s');
    await user.clear(bar.getByLabelText('Wallets per step'));
    await user.type(bar.getByLabelText('Wallets per step'), '2');
    // ceil(3 / 2) = 2 steps, the last one 6 s after the first
    expect(screen.getByTestId('stairs-plan').textContent).toBe('→ 2 steps, last one at +6.0 s');
    await user.click(bar.getByRole('button', { name: 'Buy' }));
    expect(requests.filter((r) => r.type === 'startBuy')).toEqual([
      {
        type: 'startBuy',
        mint: MINT,
        wallets: [0, 1, 2],
        group: 'g1',
        stairs: { intervalMs: 6_000, perStep: 2 },
      },
    ]);
  });

  it('Immediate: no step fields, startBuy without stairs', async () => {
    const { requests, user } = setup();
    await showMint(user);
    const bar = within(toolbar());
    await user.click(bar.getByRole('button', { name: 'Immediate' }));
    expect(bar.queryByLabelText('Seconds between steps')).toBeNull();
    await user.click(bar.getByRole('button', { name: 'Buy' }));
    const [start] = requests.filter((r) => r.type === 'startBuy');
    expect(start).toEqual({ type: 'startBuy', mint: MINT, wallets: [0, 1, 2], group: 'g1' });
  });

  // BUNNDLY-93: a run keeps its mode; the switch says why and opens again at the end
  it('while the group runs, Immediate / Stairs is off with the reason; it opens at the end', async () => {
    const { vault, user } = setup();
    await showMint(user);
    const bar = within(toolbar());
    const group = bar.getByRole('group', { name: 'Execution mode' });
    const buttons = () => within(group).getAllByRole('button');
    expect(buttons().map((b) => b.hasAttribute('disabled'))).toEqual([false, false]);
    expect(group.getAttribute('title')).toBeNull();
    act(() => {
      vault.emit(runEvent('started', true));
    });
    await eventually(() => {
      expect(buttons().map((b) => b.hasAttribute('disabled'))).toEqual([true, true]);
    });
    expect(group.getAttribute('title')).toBe('The mode can change once the current run ends.');
    await user.click(bar.getByRole('button', { name: 'Immediate' }));
    expect(bar.getByRole('button', { name: 'Stairs' }).getAttribute('aria-pressed')).toBe('true');
    act(() => {
      vault.emit(runEvent('finished', true));
    });
    await eventually(() => {
      expect(buttons().map((b) => b.hasAttribute('disabled'))).toEqual([false, false]);
    });
    expect(group.getAttribute('title')).toBeNull();
    await user.click(bar.getByRole('button', { name: 'Immediate' }));
    expect(bar.getByRole('button', { name: 'Immediate' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('a step out of 1 s – 24 h stops BUY, SELL and ARM with the reason', async () => {
    const { requests, user } = setup();
    await showMint(user);
    const bar = within(toolbar());
    await user.click(bar.getByRole('button', { name: 'Stairs' }));
    await user.clear(bar.getByLabelText('Seconds between steps'));
    await user.type(bar.getByLabelText('Seconds between steps'), '0');
    const buy = bar.getByRole('button', { name: 'Buy' });
    expect(buy).toHaveProperty('disabled', true);
    expect(buy.getAttribute('aria-description')).toBe(
      'Stairs: the step must be 1 to 86400 seconds.',
    );
    expect(bar.getByRole('button', { name: 'Sell' })).toHaveProperty('disabled', true);
    expect(bar.getByLabelText('Seconds between steps').getAttribute('aria-invalid')).toBe('true');
    await user.click(buy);
    expect(requests.filter((r) => r.type === 'startBuy')).toEqual([]);
  });

  it('a scheduled wallet counts down; Pause and Resume name the group', async () => {
    const { vault, requests, user } = setup();
    await showMint(user);
    const bar = within(toolbar());
    await user.click(bar.getByRole('button', { name: 'Stairs' }));
    await user.click(bar.getByRole('button', { name: 'Buy' }));
    await eventually(() => requests.find((r) => r.type === 'status' || r.type === 'activity'));
    const T = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(T);
    act(() => {
      vault.emit(runEvent('started', true, { intervalMs: 6_000, perStep: 1, paused: false }));
      vault.emit(walletEvent(0, 'QUEUED'));
      vault.emit(walletEvent(1, 'SCHEDULED', { scheduledAt: T + 6_000 }));
      vault.emit(walletEvent(2, 'SCHEDULED', { scheduledAt: T + 72_000 }));
    });
    // 6 s and 72 s ahead: "00:06" and "01:12"
    await eventually(() => {
      expect(fillOf('W02')).toEqual({ now: '0', text: '0%, Starts in 00:06' });
    });
    expect(fillOf('W03')).toEqual({ now: '0', text: '0%, Starts in 01:12' });
    const pause = await eventually(() => bar.getByRole('button', { name: 'Pause' }));
    await user.click(pause);
    expect(requests.filter((r) => r.type === 'pauseStairs')).toEqual([
      { type: 'pauseStairs', group: 'g1' },
    ]);
    await eventually(() => {
      expect(said()).toBe('Paused · wallets already sending will finish');
    });
    act(() => {
      vault.emit(runEvent('paused', true, { intervalMs: 6_000, perStep: 1, paused: true }));
    });
    await eventually(() => {
      expect(fillOf('W02')).toEqual({ now: '0', text: '0%, Paused' });
    });
    await user.click(await eventually(() => bar.getByRole('button', { name: 'Resume' })));
    expect(requests.filter((r) => r.type === 'resumeStairs')).toEqual([
      { type: 'resumeStairs', group: 'g1' },
    ]);
    await eventually(() => {
      expect(said()).toBe('Resumed');
    });
  });
});
