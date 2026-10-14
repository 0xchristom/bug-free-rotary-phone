// @vitest-environment jsdom
/** A custom RPC URL, keys outside storage and the console, and locking with unsaved settings. Setup: SettingsScreen.fixture.tsx. */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { enter } from './user.ts';
import {
  HELIUS_KEY,
  setup,
  field,
  retype,
  saveButton,
  saveSettings,
  keysIn,
} from './SettingsScreen.fixture.tsx';

vi.mock('@noble/hashes/scrypt.js', () => import('../helpers/fast-kdf.ts'));

describe('saving', () => {
  it('a custom RPC URL must be a Helius address (CSP); a good one is write-only too', async () => {
    const { handler, user } = await setup();
    const rpc = 'Custom RPC URL (HTTPS, optional)';
    for (const bad of [
      'https://rpc.example.com/?api-key=k1',
      'https://helius-rpc.com.evil.example/?api-key=k1',
      'https://evilhelius-rpc.com/?api-key=k1',
    ]) {
      await retype(user, rpc, bad);
      expect(
        screen.getByText(
          'Only Helius addresses in the helius-rpc.com domain are allowed (e.g. https://mainnet.helius-rpc.com/?api-key=…).',
        ),
      ).toBeTruthy();
      expect(saveButton().disabled).toBe(true);
    }
    await retype(user, rpc, 'http://mainnet.helius-rpc.com');
    expect(screen.getByText('The address must start with https://.')).toBeTruthy();
    expect(keysIn(handler)).toEqual({});

    await retype(user, rpc, 'https://staked.helius-rpc.com/?api-key=k1');
    expect(saveButton().disabled).toBe(false);
    await saveSettings(user);
    expect(keysIn(handler)).toEqual({ heliusRpcUrl: 'https://staked.helius-rpc.com/?api-key=k1' });
    expect(field(rpc).value).toBe('');
    expect(document.body.innerHTML).not.toContain('staked.helius-rpc.com');
  });

  it('the worker refuses a non-Helius URL even if the form check is bypassed', async () => {
    const { handler } = await setup();
    const err: unknown = await handler
      .handle({
        type: 'saveSettings',
        settings: handler.inspect().unlocked?.settings,
        apiKeys: { heliusWsUrl: 'wss://evilhelius-rpc.com' },
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect((err as { code?: string }).code).toBe('INVALID_SETTINGS');
  });

  it('keys never reach storage, the URL or the console', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m),
    );
    const href = window.location.href;
    const { user } = await setup();
    await enter(user, field('Helius API key'), HELIUS_KEY);
    await saveSettings(user);
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length + sessionStorage.length).toBe(0);
    expect(window.location.href).toBe(href);
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });

  it('locking with settings not written to the file asks first', async () => {
    const { user } = await setup();
    await retype(user, 'Max attempts per wallet', '4');
    await saveSettings(user);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    await user.click(screen.getByRole('button', { name: 'Lock' }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeTruthy();
  });

  it('Lock clicked the moment the file button shows still asks first (BUNNDLY-76)', async () => {
    const { handler, user } = await setup();
    await retype(user, 'Max attempts per wallet', '4');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    // Clicks Lock in the same turn React shows "Save the updated fleet file", before any
    // later task: the unsaved guard must already hold, not one effect later.
    let clicked = false;
    const observer = new MutationObserver(() => {
      if (clicked || !screen.queryByRole('button', { name: 'Save the updated fleet file' })) {
        return;
      }
      clicked = true;
      fireEvent.click(screen.getByRole('button', { name: 'Lock' }));
    });
    observer.observe(document.body, { childList: true, subtree: true });
    await user.click(saveButton());
    await waitFor(() => {
      expect(clicked).toBe(true);
    });
    observer.disconnect();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(handler.inspect().unlocked).not.toBeNull();
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeTruthy();
  });
});
