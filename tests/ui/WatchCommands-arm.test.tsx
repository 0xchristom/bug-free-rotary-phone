// @vitest-environment jsdom
/** ARM and DISARM, and the settings an armed watcher freezes. Setup: WatchCommands.fixture.tsx. */
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  CREATOR,
  setup,
  openTabB,
  typeCreator,
  armButton,
  goTo,
  arm,
} from './WatchCommands.fixture.tsx';

describe('ARM / DISARM', () => {
  it('armed with no buy: Stop and Esc are on and send stop for the group (BUNNDLY-87)', async () => {
    const { user, requests } = setup();
    await openTabB();
    const stop = screen.getByRole('button', { name: 'Stop' });
    expect(stop.getAttribute('aria-description')).toBe('Nothing is running.');
    await typeCreator(user);
    await user.click(armButton());
    await screen.findByRole('button', { name: 'Disarm' });
    expect(stop).toHaveProperty('disabled', false);
    expect(stop.getAttribute('aria-description')).toBeNull();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(requests.filter((r) => r.type === 'stop')).toEqual([{ type: 'stop', group: 'g1' }]);
    });
    // stopped: disarmed, so Stop is off again and Arm is back
    await screen.findByRole('button', { name: 'Arm' });
    // BUNNDLY-90: no run, so no wallet is counted; the rail says the group is disarmed
    expect(screen.getByRole('status', { name: 'Last command' }).textContent).toBe(
      'Stopped · the group is disarmed',
    );
    expect(screen.getByRole('button', { name: 'Stop' }).getAttribute('aria-description')).toBe(
      'Nothing is running.',
    );
    await user.click(screen.getByRole('button', { name: 'Stop' }));
    expect(requests.filter((r) => r.type === 'stop')).toHaveLength(1);
  });

  it('DRY-RUN: ARM sends arm at once, DISARM sends disarm', async () => {
    const { user, requests } = setup();
    await arm(user);
    expect(requests.filter((r) => r.type === 'arm')).toEqual([
      { type: 'arm', creator: CREATOR, wallets: [0, 1, 2], group: 'g1' },
    ]);
    expect(screen.getByText(/The watcher is armed. Do not close/u)).toBeTruthy();
    // BUNNDLY-90: the rail says what the command did
    expect(screen.getByRole('status', { name: 'Last command' }).textContent).toBe(
      'Armed · the fleet buys as soon as the creator launches a token',
    );
    await user.click(screen.getByRole('button', { name: 'Disarm' }));
    expect(requests.some((r) => r.type === 'disarm')).toBe(true);
    await screen.findByRole('button', { name: 'Arm' });
    await waitFor(() => {
      expect(screen.getByRole('status', { name: 'Last command' }).textContent).toBe('Disarmed');
    });
  });

  it('live mode: only after the confirmation; "Cancel" sends nothing', async () => {
    const { user, requests } = setup({ global: { dryRun: false } });
    await openTabB();
    await typeCreator(user);
    await user.click(armButton());
    const dialog = screen.getByRole('alertdialog', { name: 'Arm the watcher in live mode?' });
    // 3 wallets × 0.01 SOL saved max spend
    expect(within(dialog).getByText('Wallets').nextElementSibling?.textContent).toBe('3');
    expect(within(dialog).getByText('up to 0.03 SOL')).toBeTruthy();
    expect(within(dialog).getByText(/one buy, then the watcher disarms/u)).toBeTruthy();
    expect(requests.some((r) => r.type === 'arm')).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(requests.some((r) => r.type === 'arm')).toBe(false);
    await user.click(armButton());
    await user.click(screen.getByRole('button', { name: 'Yes, arm' }));
    await screen.findByRole('button', { name: 'Disarm' });
    expect(requests.filter((r) => r.type === 'arm')).toHaveLength(1);
  });

  // Since BUNNDLY-73 the mode is set in Settings only (it was on the watch panel too).
  it('continuous mode needs a confirmation and is saved as a setting', async () => {
    const { user, requests } = setup();
    await openTabB();
    await goTo(user, 'Settings');
    const confirm = vi
      .spyOn(window, 'confirm')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    const continuous = await screen.findByRole<HTMLInputElement>('radio', {
      name: 'Continuous (the watcher buys each new detected token)',
    });
    await user.click(continuous);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]?.[0]).toMatch(/Turn on continuous mode/u);
    expect(continuous.checked).toBe(false);
    await user.click(continuous);
    expect(continuous.checked).toBe(true);
    expect(requests.some((r) => r.type === 'saveSettings')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => {
      expect(requests.find((r) => r.type === 'saveSettings')).toMatchObject({
        settings: { global: { mode: 'continuous' } },
      });
    });
    confirm.mockRestore();
  });
});

describe('an armed watcher freezes the settings', () => {
  it('no mode switch, no table, wallet or settings save until DISARM', async () => {
    const { user } = setup();
    await arm(user);
    const modeSwitch = screen.getByRole('switch', { name: 'DRY-RUN' });
    expect(modeSwitch).toHaveProperty('disabled', true);
    expect(modeSwitch.getAttribute('aria-description')).toMatch(
      /Disarm the watcher to change the mode or the settings/u,
    );
    expect(
      screen.getAllByText(/Disarm the watcher to change the mode or the settings/u).length,
    ).toBe(
      1, // table (the mode switch and Create wallets say it in their description, BUNNDLY-82)
    );
    expect(
      screen.getByRole('button', { name: 'Create wallets' }).getAttribute('aria-description'),
    ).toMatch(/Disarm the watcher to change the mode or the settings/u);
    expect(screen.getByRole('button', { name: 'Save table changes' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('button', { name: 'Create wallets' })).toHaveProperty('disabled', true);
    await user.click(
      within(screen.getByRole('navigation')).getByRole('button', { name: 'Settings' }),
    );
    expect(await screen.findByRole('button', { name: 'Save settings' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByText(/Disarm the watcher to change/u)).toBeTruthy();
    await goTo(user, 'Dashboard');
    await user.click(screen.getByRole('button', { name: 'Disarm' }));
    await waitFor(() => {
      expect(screen.getByRole('switch', { name: 'DRY-RUN' })).toHaveProperty('disabled', false);
    });
    expect(screen.queryByText(/Disarm the watcher to change/u)).toBeNull();
  });
});
