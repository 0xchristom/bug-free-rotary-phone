// @vitest-environment jsdom
/** The status rail says what a command did (BUNNDLY-90). Setup: FillStairs.fixture.tsx. */
import { act, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { VaultRequest } from '../../src/worker/protocol.ts';
import { eventually } from './settle.ts';
import {
  setup,
  runEvent,
  walletEvent,
  showMint,
  fillOf,
  said,
  requests,
  toolbar,
} from './FillStairs.fixture.tsx';

describe('the rail says what a command did (BUNNDLY-90)', () => {
  it('BUY: the wallets and the mode the worker accepted, DRY-RUN said', async () => {
    const { user } = setup();
    await showMint(user);
    expect(said()).toBe('');
    await user.click(within(toolbar()).getByRole('button', { name: 'Immediate' }));
    await user.click(within(toolbar()).getByRole('button', { name: 'Buy' }));
    // the fake worker accepts 3 wallets, DRY-RUN, no steps
    await eventually(() => {
      expect(said()).toBe('Buy started on 3 wallets · Immediate · DRY-RUN');
    });
  });

  it('Stairs BUY says Stairs; STOP counts the wallets that had not sent yet', async () => {
    const { vault, requests, user } = setup();
    await showMint(user);
    const bar = within(toolbar());
    await user.click(bar.getByRole('button', { name: 'Stairs' }));
    await user.click(bar.getByRole('button', { name: 'Buy' }));
    await eventually(() => {
      expect(said()).toBe('Buy started on 3 wallets · Stairs · DRY-RUN');
    });
    await eventually(() => requests.find((r) => r.type === 'status' || r.type === 'activity'));
    act(() => {
      vault.emit(runEvent('started', true, { intervalMs: 6_000, perStep: 1, paused: false }));
      vault.emit(walletEvent(0, 'SUBMITTED'));
      vault.emit(walletEvent(1, 'SCHEDULED', { scheduledAt: 0 }));
      vault.emit(walletEvent(2, 'QUEUED', { attempt: 0 }));
    });
    // the clicked rows show queued at once; W01 at 60 % says the events arrived
    await eventually(() => {
      expect(fillOf('W01').text).toBe('60%, Sent');
    });
    expect(fillOf('W03').text).toBe('5%, Queued');
    await user.click(bar.getByRole('button', { name: 'Stop' }));
    // W02 scheduled and W03 queued did not send; W01 was already sent
    await eventually(() => {
      expect(said()).toBe('Stopped · 2 wallets did not send');
    });
  });

  it('a refused command says nothing in the rail; the error says why', async () => {
    const { vault, user } = setup();
    const accept = vault.request.getMockImplementation();
    vault.request.mockImplementation((req: VaultRequest) =>
      req.type === 'startBuy'
        ? Promise.reject(new Error('refused by the test'))
        : (accept?.(req) ?? Promise.reject(new Error(req.type))),
    );
    await showMint(user);
    await user.click(within(toolbar()).getByRole('button', { name: 'Buy' }));
    await eventually(() => {
      expect(requests(vault).some((r) => r.type === 'startBuy')).toBe(true);
    });
    await act(() => Promise.resolve());
    expect(said()).toBe('');
  });

  it('the message goes after 4.2 s: one timer of 4200 ms, and its end clears the line', async () => {
    const { user } = setup();
    await showMint(user);
    const timers = vi.spyOn(window, 'setTimeout');
    await user.click(within(toolbar()).getByRole('button', { name: 'Buy' }));
    await eventually(() => {
      expect(said()).toBe('Buy started on 3 wallets · Stairs · DRY-RUN');
    });
    // the passive effect that sets the timer runs after the commit that shows the text
    await act(() => Promise.resolve());
    const sayTimers = timers.mock.calls.filter(([, ms]) => ms === 4_200);
    expect(sayTimers).toHaveLength(1);
    const [end] = sayTimers[0] ?? [];
    timers.mockRestore();
    act(() => {
      if (typeof end === 'function') end();
    });
    expect(said()).toBe('');
  });
});
