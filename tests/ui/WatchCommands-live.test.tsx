// @vitest-environment jsdom
/** The watcher's detections and progress. Setup: WatchCommands.fixture.tsx. */
import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { RunEvent } from '../../src/executor/index.ts';
import { TARGET_LABEL, TARGET_WAIT } from './fakes.ts';
import { enter } from './user.ts';
import { MINT, ARMED_REASON, detection, setup, goTo, arm } from './WatchCommands.fixture.tsx';

describe('detections and progress', () => {
  it('the list: time, short mint with copy, source, path, reaction, verified, result', async () => {
    const { user, update } = setup();
    await arm(user);
    update({
      connection: 'connected',
      detections: [
        detection(),
        detection({
          mint: 'Cv3DkGpXCiMeacQSWrshtrZjWkzVKpPUxfYz5RMQpump',
          source: 'raydium-launchlab',
          path: 'transaction',
          runId: null,
          reactionMs: null,
          verified: null,
        }),
        detection({
          mint: '5vxZ1ZhyeqKW33V41E5dFsegrUhdGxGKU5rx4u4Xpump',
          source: 'initialize-mint',
          path: 'catch-up',
          runId: null,
          reactionMs: null,
          verified: null,
          problem: 'STALE',
        }),
      ],
      queued: ['Cv3DkGpXCiMeacQSWrshtrZjWkzVKpPUxfYz5RMQpump'],
    });
    // the list is on the Activity screen since BUNNDLY-73, with the group of each detection
    await screen.findByLabelText(/^Detected token/u);
    await goTo(user, 'Activity');
    const table = await screen.findByRole('table', { name: 'Detections' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringMatching(/HEhu…pump.*All wallets.*pump\.fun.*log.*4 ms.*verified.*buy #1/u),
      expect.stringMatching(/Cv3D…pump.*LaunchLab.*transaction.*–.*queued/u),
      expect.stringMatching(/5vxZ…pump.*InitializeMint.*catch-up.*from before arming/u),
    ]);
    expect(within(table).getByRole('button', { name: `Copy mint ${MINT}` })).toBeTruthy();
  });

  it('armed: BUY on the bar and ▶ in the rows are off with DISARM first, a pasted mint too (BUNNDLY-86)', async () => {
    const { user, requests } = setup();
    await arm(user);
    const input = screen.getByLabelText(TARGET_LABEL);
    await user.clear(input);
    await enter(user, input, MINT);
    await screen.findByText('Token · SPL', {}, TARGET_WAIT);
    const buy = screen.getByRole('button', { name: 'Buy' });
    expect(buy).toHaveProperty('disabled', true);
    expect(buy.getAttribute('aria-description')).toBe(ARMED_REASON);
    const row = screen.getByRole('button', { name: 'Buy W02' });
    expect(row).toHaveProperty('disabled', true);
    expect(row.getAttribute('aria-description')).toBe(ARMED_REASON);
    await user.click(buy);
    await user.click(row);
    expect(requests.filter((r) => r.type === 'startBuy')).toEqual([]);
  });

  it('the bar shows the newest usable detection; BUY can buy it once disarmed (BUNNDLY-59, 86)', async () => {
    const { user, update } = setup();
    await arm(user);
    const buy = screen.getByRole('button', { name: 'Buy' });
    expect(buy).toHaveProperty('disabled', true);
    expect(screen.queryByLabelText(/^Detected token/u)).toBeNull();
    const usable = 'Cv3DkGpXCiMeacQSWrshtrZjWkzVKpPUxfYz5RMQpump';
    update({
      connection: 'connected',
      detections: [
        detection(),
        detection({ mint: usable, source: 'raydium-launchlab', runId: null }),
        // newest, but from before arming: not a token to buy
        detection({
          mint: '5vxZ1ZhyeqKW33V41E5dFsegrUhdGxGKU5rx4u4Xpump',
          runId: null,
          problem: 'STALE',
        }),
      ],
    });
    const chip = await screen.findByLabelText(`Detected token ${usable}`);
    expect(chip.textContent).toBe('Detected Cv3D…pump · LaunchLab');
    // still armed (continuous): the watcher buys, not the bar, and no sell meanwhile
    expect(screen.getByRole('button', { name: 'Buy' }).getAttribute('aria-description')).toBe(
      ARMED_REASON,
    );
    const sell = screen.getByRole('button', { name: 'Sell' });
    expect(sell).toHaveProperty('disabled', true);
    expect(sell.getAttribute('aria-description')).toBe(ARMED_REASON);
    // a one-shot detection disarms the group: its token is the bar's to buy
    update({ armed: false, connection: 'disconnected' });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Buy' })).toHaveProperty('disabled', false);
    });
    expect(screen.getByLabelText(`Detected token ${usable}`)).toBeTruthy();
  });

  it('after a detection: its slot and the time to the first send, from the worker (BUNNDLY-91)', async () => {
    const { user, update } = setup();
    await arm(user);
    // The worker's record: slot of the log notification, 37.6 ms from the log to /order.
    update({
      connection: 'connected',
      detections: [detection({ slot: 452_762_723, reactionMs: 37.6 })],
    });
    const line = await screen.findByText(/^Token detected/u);
    expect(line.textContent).toBe('Token detected in slot 452762723 · first buy sent +38 ms');
    // Nothing reported yet: said so, not a slot 0 or a time from the UI clock.
    update({ detections: [detection({ slot: null, reactionMs: null })] });
    await waitFor(() => {
      expect(screen.getByText(/^Token detected/u).textContent).toBe(
        'Token detected, slot unknown · first buy not sent yet',
      );
    });
  });

  it('a buy started by a detection: the shared progress view counts from the detection', async () => {
    const { user, update, vault } = setup();
    await arm(user);
    update({ connection: 'connected', detections: [detection()] });
    await goTo(user, 'Activity');
    await screen.findByRole('table', { name: 'Detections' });
    await goTo(user, 'Dashboard');
    const started: RunEvent = {
      kind: 'run',
      runId: 1,
      at: 0,
      phase: 'started',
      mint: MINT,
      dryRun: true,
      wallets: 3,
      counts: {
        IDLE: 3,
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
    act(() => {
      vault.emit(started);
    });
    // the run is shown once its times count from the detection; "0 of 3 filled" is there
    // before any run too (BUNNDLY-93), so it does not say the run arrived
    expect(await screen.findByTitle('Counted from the detection')).toBeTruthy();
    // fleetFill (BUNNDLY-56): no wallet event yet, the 3 selected wallets wait
    expect(screen.getByText(/^Fleet fill · 0 of 3 filled$/u)).toBeTruthy();
  });
});
