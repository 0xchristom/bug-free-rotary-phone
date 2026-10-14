// @vitest-environment jsdom
/** The watcher's connection, alarm and Wake Lock. Setup: WatchCommands.fixture.tsx. */
import { act, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ALARM_REPEAT_MS } from '../../src/ui/watch-runtime.ts';
import { mockWakeLock, setup, arm } from './WatchCommands.fixture.tsx';

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
