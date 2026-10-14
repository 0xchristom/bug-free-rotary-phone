// @vitest-environment jsdom
/** The watcher's connection, alarm and Wake Lock, detections and progress. Setup: WatchCommands.fixture.tsx. */
import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { RunEvent } from '../../src/executor/index.ts';
import { ALARM_REPEAT_MS } from '../../src/ui/watch-runtime.ts';
import { TARGET_LABEL, TARGET_WAIT } from './fakes.ts';
import { enter } from './user.ts';
import {
  MINT,
  ARMED_REASON,
  mockWakeLock,
  detection,
  setup,
  goTo,
  arm,
} from './WatchCommands.fixture.tsx';

describe('connection, alarm and Wake Lock', () => {
  it('connection states as text; losing it while armed: banner and tone until it is back', async () => {
    const { user, update, audio } = setup();
    await arm(user);
    expect(audio.created()).toBe(1); // made by the click on ARM
    expect(await screen.findByText('Connecting…')).toBeTruthy();
    update({ connection: 'connected', lastMessageAt: Date.now() });
    expect(await screen.findByText('Connected')).toBeTruthy();
    expect(screen.getByText(/last message \d+ s ago/u)).toBeTruthy();
    expect(audio.tones).toHaveLength(0);

    update({ connection: 'reconnecting', attempt: 2 });
    const banner = await screen.findByText(/The connection to Helius was lost/u);
    expect(banner.closest('[role="alert"]')).toBeTruthy();
    expect(screen.getAllByText(/Reconnecting \(attempt 2\)/u).length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(audio.tones.length).toBeGreaterThanOrEqual(1);
    });

    update({ connection: 'connected' });
    await waitFor(() => {
      expect(screen.queryByText(/The connection to Helius was lost/u)).toBeNull();
    });
    const after = audio.tones.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(audio.tones).toHaveLength(after);
  });

  it('armed: the time since arming as mm:ss from the worker armedAt, next to the connection (BUNNDLY-91)', async () => {
    const { user, update } = setup();
    await arm(user);
    const clock = () => screen.getByTitle('Time since arming');
    // Armed 65 s ago by the worker's record; the bar ticks once a second, so 1 s of lag.
    update({ connection: 'connected', armedAt: new Date(Date.now() - 65_000).toISOString() });
    await waitFor(() => {
      expect(clock().textContent).toMatch(/^01:0[456]$/u);
    });
    const line = clock().closest('.watchtext');
    expect(line?.textContent).toMatch(/^Armed · watching \S+ for 01:0[456] · Connected/u);
    // Past an hour the minutes go on: 61:05, not 01:05.
    update({ armedAt: new Date(Date.now() - 3_665_000).toISOString() });
    await waitFor(() => {
      expect(clock().textContent).toMatch(/^61:0[456]$/u);
    });
    // The clock moves on its own while armed.
    const shown = clock().textContent;
    await waitFor(
      () => {
        expect(clock().textContent).not.toBe(shown);
      },
      { timeout: 2_500 },
    );
    expect(screen.getByText('Connected')).toBeTruthy();
  });

  it('the time since arming counts from the moment it is shown, not from when the bar opened (BUNNDLY-75)', async () => {
    const opened = Date.now();
    const clockNow = vi.spyOn(Date, 'now').mockReturnValue(opened);
    try {
      const { user, update } = setup();
      await arm(user);
      // 30 s after the bar opened, the worker says it armed 65 s ago: 01:05 at once,
      // without waiting for the next once-a-second tick (that would show 00:35 first)
      clockNow.mockReturnValue(opened + 30_000);
      update({ connection: 'connected', armedAt: new Date(opened - 35_000).toISOString() });
      await waitFor(
        () => {
          expect(screen.getByTitle('Time since arming').textContent).toBe('01:05');
        },
        { timeout: 500 },
      );
    } finally {
      clockNow.mockRestore();
    }
  });

  it('the tone repeats until "Mute"; the banner stays', async () => {
    const { user, update, audio } = setup({ alarmRepeatMs: 20 });
    await arm(user);
    update({ connection: 'disconnected' });
    await screen.findByText(/The connection to Helius was lost/u);
    await waitFor(() => {
      expect(audio.tones.length).toBeGreaterThanOrEqual(3);
    });
    await user.click(screen.getByRole('button', { name: 'Mute' }));
    const muted = audio.tones.length;
    await new Promise((r) => setTimeout(r, 150));
    expect(audio.tones).toHaveLength(muted);
    expect(screen.getByText(/The connection to Helius was lost/u)).toBeTruthy();
  });

  it('the default repeat is every 3 s', () => {
    expect(ALARM_REPEAT_MS).toBe(3_000);
  });

  it('Wake Lock: held while armed, requested again after the tab is visible again, released on disarm', async () => {
    const { user, wake } = setup();
    await arm(user);
    await waitFor(() => {
      expect(wake.request).toHaveBeenCalledTimes(1);
    });
    expect(wake.request).toHaveBeenCalledWith('screen');
    // the browser lets go when the tab is hidden; visible again → a new request
    act(() => {
      wake.sentinels[0]?.drop();
    });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => {
      expect(wake.request).toHaveBeenCalledTimes(2);
    });
    await user.click(screen.getByRole('button', { name: 'Disarm' }));
    await waitFor(() => {
      expect(wake.releases).toHaveBeenCalledWith(1);
    });
  });

  it('no Wake Lock API: a note in the panel, no error', async () => {
    const { user } = setup({ browser: { wakeLock: null } });
    await arm(user);
    expect(await screen.findByText(/The screen may turn off/u)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('Wake Lock refused: the same note', async () => {
    const { user } = setup({ browser: { wakeLock: mockWakeLock(true).api } });
    await arm(user);
    expect(await screen.findByText(/The screen may turn off/u)).toBeTruthy();
  });
});

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
