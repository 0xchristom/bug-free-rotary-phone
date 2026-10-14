// @vitest-environment jsdom
/** Saving the settings, auto-lock and API keys. Setup: SettingsScreen.fixture.tsx. */
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_GLOBAL_SETTINGS, openKeystore, parseKeystoreFile } from '../../src/core/index.ts';
import { enter } from './user.ts';
import {
  PASSWORD,
  HELIUS_KEY,
  JUPITER_KEY,
  FILE_NAME,
  setup,
  field,
  retype,
  saveButton,
  saveSettings,
  keysIn,
} from './SettingsScreen.fixture.tsx';

vi.mock('@noble/hashes/scrypt.js', () => import('../helpers/fast-kdf.ts'));

describe('saving', () => {
  it('saves settings in the vault and the file; they come back after reopening', async () => {
    const { handler, storage, user } = await setup();
    await retype(user, 'Minimum reserve (MIN_RESERVE_SOL)', '0,02');
    await retype(user, 'Max attempts per wallet', '5');
    await retype(user, /^Price ceiling/u, '120');
    await retype(user, '“No route” retry window', '30');
    await retype(user, 'Retry delay: first', '250');
    await retype(user, 'Retry delay: longest', '4000');
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Auto-lock after inactivity' }),
      '60',
    );
    await user.selectOptions(screen.getByRole('combobox', { name: 'Transaction explorer' }), 'orb');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Jupiter plan' }), 'launch');
    await saveSettings(user);

    const expected = {
      ...DEFAULT_GLOBAL_SETTINGS,
      minReserveLamports: 20_000_000n,
      maxAttempts: 5,
      priceCeilingPercent: 120,
      noRouteWindowMs: 30_000,
      noRouteBackoffMinMs: 250,
      noRouteBackoffMaxMs: 4_000,
      explorer: 'orb',
      autoLockMinutes: 60,
      jupiterPlan: 'launch',
      orderRpm: 3000,
    };
    expect(handler.inspect().unlocked?.settings.global).toEqual(expected);
    // the header follows the new auto-lock time
    expect(screen.getByText('Auto-lock after 1 h of inactivity')).toBeTruthy();
    expect(screen.getByText(/the fleet file is not updated yet/u)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Save the updated fleet file' }));
    await screen.findByText(`Saved ${FILE_NAME} with the new settings.`);
    const saved = storage.files.get(FILE_NAME);
    if (saved === undefined) throw new Error('not saved');
    const reopened = await openKeystore(parseKeystoreFile(saved), PASSWORD);
    expect(reopened.secrets.settings.global).toEqual(expected);
  });

  it('auto-lock is a list of exactly four choices, off first (BUNNDLY-51)', async () => {
    await setup();
    const select = screen.getByRole('combobox', { name: 'Auto-lock after inactivity' });
    const options = within(select).getAllByRole<HTMLOptionElement>('option');
    expect(options.map((o) => [o.value, o.textContent])).toEqual([
      ['off', 'Off'],
      ['15', '15 min'],
      ['60', '1 h'],
      ['120', '2 h'],
    ]);
    const rail = within(screen.getByRole('contentinfo', { name: 'Status' }));
    expect(rail.getByText('Auto-lock: off')).toBeTruthy();
  });

  it.each<[string, number | null, string]>([
    ['15', 15, 'Auto-lock after 15 min of inactivity'],
    ['60', 60, 'Auto-lock after 1 h of inactivity'],
    ['120', 120, 'Auto-lock after 2 h of inactivity'],
    ['off', null, 'Auto-lock: off'],
  ])(
    'auto-lock %s is saved in the worker and shown in the status rail',
    async (value, minutes, rail) => {
      const { handler, user, requests } = await setup();
      const select = screen.getByRole('combobox', { name: 'Auto-lock after inactivity' });
      // from another value, so "off" is a real change too
      await user.selectOptions(select, value === 'off' ? '120' : 'off');
      if (value === 'off') {
        await saveSettings(user);
        // the form opens again once the file is written
        await user.click(screen.getByRole('button', { name: 'Save the updated fleet file' }));
        await screen.findByText(`Saved ${FILE_NAME} with the new settings.`);
        expect(handler.inspect().unlocked?.settings.global.autoLockMinutes).toBe(120);
      }
      requests.length = 0;
      await user.selectOptions(select, value);
      await user.click(saveButton());
      await waitFor(() => {
        expect(handler.inspect().unlocked?.settings.global.autoLockMinutes).toBe(minutes);
      });
      const sent = requests.find(
        (r): r is { type: 'saveSettings'; settings: { global: { autoLockMinutes: unknown } } } =>
          (r as { type?: string }).type === 'saveSettings',
      );
      expect(sent?.settings.global.autoLockMinutes).toBe(minutes);
      const status = within(screen.getByRole('contentinfo', { name: 'Status' }));
      await status.findByText(rail);
    },
  );

  it('typed keys go to the worker only; the form is cleared and shows "Set."', async () => {
    const { handler, user, requests } = await setup();
    await enter(user, field('Helius API key'), HELIUS_KEY);
    await enter(user, field('Jupiter API key'), JUPITER_KEY);
    // "Show" shows only the text typed now
    expect(field('Helius API key').type).toBe('password');
    await user.click(screen.getByRole('button', { name: 'Show the typed text: Helius API key' }));
    expect(field('Helius API key').type).toBe('text');
    await saveSettings(user);

    expect(keysIn(handler)).toEqual({ helius: HELIUS_KEY, jupiter: JUPITER_KEY });
    expect(requests.at(-2)).toMatchObject({
      type: 'saveSettings',
      apiKeys: { helius: HELIUS_KEY, jupiter: JUPITER_KEY },
    });
    expect(field('Helius API key').value).toBe('');
    expect(field('Helius API key').type).toBe('password');
    expect(field('Jupiter API key').value).toBe('');
    expect(screen.getAllByText('Set.')).toHaveLength(2);
    expect(document.body.innerHTML).not.toContain(HELIUS_KEY);
    expect(document.body.innerHTML).not.toContain(JUPITER_KEY);
  });

  it('an empty field keeps the key; "Remove" removes it', async () => {
    const { handler, storage, user } = await setup();
    // later saves overwrite the same file
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await enter(user, field('Helius API key'), HELIUS_KEY);
    await enter(user, field('Jupiter API key'), JUPITER_KEY);
    await saveSettings(user);
    await user.click(screen.getByRole('button', { name: 'Save the updated fleet file' }));
    await screen.findByText(/with the new settings/u);

    // nothing typed: keys stay
    await retype(user, 'Max attempts per wallet', '4');
    await saveSettings(user);
    expect(keysIn(handler)).toEqual({ helius: HELIUS_KEY, jupiter: JUPITER_KEY });
    await user.click(screen.getByRole('button', { name: 'Save the updated fleet file' }));
    await screen.findByText(/with the new settings/u);

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('already exists'));
    expect(storage.files.size).toBe(1);

    await user.click(screen.getByRole('button', { name: 'Remove: Jupiter API key' }));
    expect(screen.getByText('Will be removed when the settings are saved.')).toBeTruthy();
    expect(field('Jupiter API key').disabled).toBe(true);
    await saveSettings(user);
    expect(keysIn(handler)).toEqual({ helius: HELIUS_KEY });
    expect(screen.getAllByText('Set.')).toHaveLength(1);
  });
});
