// @vitest-environment jsdom
/** Settings screen (BUNNDLY-15) against the real vault handler. */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_GLOBAL_SETTINGS, openKeystore, parseKeystoreFile } from '../../src/core/index.ts';
import { App } from '../../src/ui/App.tsx';
import type { VaultFileResult } from '../../src/worker/protocol.ts';
import { createVaultHandler, type VaultHandler } from '../../src/worker/vault.ts';
import type { VaultClient } from '../../src/worker/vault-client.ts';
import { mockStorage } from './fakes.ts';

const PASSWORD = 'zielony Kot, 7 krzeseł; drabina';
const HELIUS_KEY = 'heliusKeyUiTest123';
const JUPITER_KEY = 'jupiterKeyUiTest456';
const FILE_NAME = 'Ustawienia.keystore.json';

vi.setConfig({ testTimeout: 60_000 });

async function setup() {
  const handler = createVaultHandler();
  await handler.handle({
    type: 'create',
    fleetName: 'Ustawienia',
    walletCount: 2,
    password: PASSWORD,
  });
  const requests: unknown[] = [];
  const client = {
    request: (request: unknown, options?: object) => {
      requests.push(request);
      return handler.handle(request, options);
    },
    onEvent: (l) => handler.onEvent(l),
  } as VaultClient;
  const storage = mockStorage();
  render(<App vault={client} storage={storage.env} statusPollMs={60_000} />);
  const user = userEvent.setup();
  const nav = await screen.findByRole('navigation', {}, { timeout: 10_000 });
  await user.click(within(nav).getByRole('button', { name: 'Settings' }));
  await screen.findByRole('heading', { name: 'Settings' });
  return { handler, storage, user, requests };
}

function field(label: string | RegExp): HTMLInputElement {
  return screen.getByLabelText(label);
}

async function retype(user: UserEvent, label: string | RegExp, text: string): Promise<void> {
  await user.clear(field(label));
  if (text !== '') await user.type(field(label), text);
}

function saveButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Save settings' });
}

async function saveSettings(user: UserEvent): Promise<void> {
  await user.click(saveButton());
  await screen.findByRole('button', { name: 'Save the updated fleet file' });
}

function keysIn(handler: VaultHandler): unknown {
  return handler.inspect().unlocked?.apiKeys;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('form', () => {
  it('shows the defaults and that no key is set', async () => {
    await setup();
    expect(field('Minimum reserve (MIN_RESERVE_SOL)').value).toBe('0.015');
    expect(field('Max attempts per wallet').value).toBe('3');
    expect(field(/^Price ceiling/u).value).toBe('50');
    expect(field('“No route” retry window').value).toBe('20');
    expect(field('Retry delay: first').value).toBe('500');
    expect(field('Retry delay: longest').value).toBe('2000');
    expect(field('Auto-lock after inactivity').value).toBe('15');
    expect(screen.getByRole<HTMLInputElement>('radio', { name: /^One-shot/u }).checked).toBe(true);
    expect(
      screen.getByRole<HTMLSelectElement>('combobox', { name: 'Transaction explorer' }).value,
    ).toBe('solscan');
    expect(screen.getByText(/\/order limit: 60\/min \(\s*1\/s/u)).toBeTruthy();
    expect(screen.getAllByText('Not set.')).toHaveLength(4);
    expect(screen.queryByRole('button', { name: /^Remove/u })).toBeNull();
  });

  it.each<[string | RegExp, string, string]>([
    [/^Price ceiling/u, '0', 'The price ceiling must be a whole number from 1 to 1000%.'],
    [/^Price ceiling/u, '1001', 'The price ceiling must be a whole number from 1 to 1000%.'],
    ['Max attempts per wallet', '11', 'Attempts must be a whole number from 1 to 10.'],
    ['Max attempts per wallet', 'three', 'Attempts must be a whole number from 1 to 10.'],
    [
      'Minimum reserve (MIN_RESERVE_SOL)',
      '0,004',
      'The minimum reserve must be between 0.005 and 1 SOL.',
    ],
    [
      'Minimum reserve (MIN_RESERVE_SOL)',
      'abc',
      'The minimum reserve must be between 0.005 and 1 SOL.',
    ],
    ['“No route” retry window', '500', 'The “no route” window must be between 1 and 120 s.'],
    [
      'Retry delay: longest',
      '400',
      'The longest retry delay cannot be shorter than the first one.',
    ],
    ['Auto-lock after inactivity', '0', 'Auto-lock must be between 1 and 120 minutes.'],
  ])('%s = %s → English message, save disabled', async (label, value, message) => {
    const { user } = await setup();
    await retype(user, label, value);
    expect(screen.getByText(message)).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
  });

  it('every number field carries its unit inside the field and names it to screen readers', async () => {
    const { user } = await setup();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Jupiter plan' }), 'custom');
    const units: [string | RegExp, string][] = [
      ['/order limit (requests per minute)', '/min'],
      ['Minimum reserve (MIN_RESERVE_SOL)', 'SOL'],
      ['Max attempts per wallet', 'attempts'],
      [/^Price ceiling/u, '%'],
      ['“No route” retry window', 's'],
      ['Retry delay: first', 'ms'],
      ['Retry delay: longest', 'ms'],
      ['Auto-lock after inactivity', 'min'],
      ['Sell part', '%'],
      ['Buy slippage', '%'],
      ['Sell slippage', '%'],
      ['Priority fee', 'SOL'],
    ];
    for (const [label, unit] of units) {
      const input = field(label);
      // the unit is drawn in the same box as the number, not beside or under it
      const box = input.closest('.k-num');
      expect(box?.querySelector('.k-num-unit')?.textContent, String(label)).toBe(unit);
      expect(input.getAttribute('aria-description'), String(label)).toBe(unit);
    }
    // the default buy amount switches between SOL and % with a button next to the field
    expect(
      screen.getByRole('button', { name: /^Unit of the default buy amount: SOL/u }).textContent,
    ).toBe('SOL');
    expect(document.querySelectorAll('.k-num')).toHaveLength(units.length + 1);

    // a wrong value still marks the field itself
    expect(field(/^Price ceiling/u).getAttribute('aria-invalid')).toBeNull();
    await retype(user, /^Price ceiling/u, '0');
    expect(field(/^Price ceiling/u).getAttribute('aria-invalid')).toBe('true');
    expect(field('Max attempts per wallet').getAttribute('aria-invalid')).toBeNull();
  });

  it('Jupiter plan sets the limit; "Custom" lets the user type it', async () => {
    const { user } = await setup();
    const plan = screen.getByRole('combobox', { name: 'Jupiter plan' });
    await user.selectOptions(plan, 'developer');
    expect(screen.getByText(/\/order limit: 600\/min \(\s*10\/s/u)).toBeTruthy();
    await user.selectOptions(plan, 'keyless');
    expect(screen.getByText(/\/order limit: 30\/min \(\s*0\.5\/s/u)).toBeTruthy();
    await user.selectOptions(plan, 'custom');
    await retype(user, '/order limit (requests per minute)', '0');
    expect(screen.getByText(/from 1 to 100000 requests per minute/u)).toBeTruthy();
    await retype(user, '/order limit (requests per minute)', '1200');
    expect(saveButton().disabled).toBe(false);
  });

  it('continuous mode needs confirming the warning', async () => {
    const { user } = await setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    const continuous = screen.getByRole<HTMLInputElement>('radio', { name: /^Continuous/u });
    await user.click(continuous);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(continuous.checked).toBe(false);
    confirm.mockReturnValueOnce(true);
    await user.click(continuous);
    expect(continuous.checked).toBe(true);
    expect(screen.getByText(/Continuous mode is on/u)).toBeTruthy();
  });
});

describe('saving', () => {
  it('saves settings in the vault and the file; they come back after reopening', async () => {
    const { handler, storage, user } = await setup();
    await retype(user, 'Minimum reserve (MIN_RESERVE_SOL)', '0,02');
    await retype(user, 'Max attempts per wallet', '5');
    await retype(user, /^Price ceiling/u, '120');
    await retype(user, '“No route” retry window', '30');
    await retype(user, 'Retry delay: first', '250');
    await retype(user, 'Retry delay: longest', '4000');
    await retype(user, 'Auto-lock after inactivity', '30');
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
      autoLockMinutes: 30,
      jupiterPlan: 'launch',
      orderRpm: 3000,
    };
    expect(handler.inspect().unlocked?.settings.global).toEqual(expected);
    // the header follows the new auto-lock time
    expect(screen.getByText('Auto-lock after 30 min of inactivity')).toBeTruthy();
    expect(screen.getByText(/the fleet file is not updated yet/u)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Save the updated fleet file' }));
    await screen.findByText(`Saved ${FILE_NAME} with the new settings.`);
    const saved = storage.files.get(FILE_NAME);
    if (saved === undefined) throw new Error('not saved');
    const reopened = await openKeystore(parseKeystoreFile(saved), PASSWORD);
    expect(reopened.secrets.settings.global).toEqual(expected);
  });

  it('typed keys go to the worker only; the form is cleared and shows "Set."', async () => {
    const { handler, user, requests } = await setup();
    await user.type(field('Helius API key'), HELIUS_KEY);
    await user.type(field('Jupiter API key'), JUPITER_KEY);
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
    await user.type(field('Helius API key'), HELIUS_KEY);
    await user.type(field('Jupiter API key'), JUPITER_KEY);
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
    await user.type(field('Helius API key'), HELIUS_KEY);
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
});

describe('VaultInfo in the UI', () => {
  it('has only flags for the keys', async () => {
    const { handler, user } = await setup();
    await user.type(field('Helius API key'), HELIUS_KEY);
    await saveSettings(user);
    const status = (await handler.handle({ type: 'status' })) as { info: VaultFileResult['info'] };
    expect(status.info.apiKeys).toEqual({
      helius: true,
      jupiter: false,
      heliusRpcUrl: false,
      heliusWsUrl: false,
    });
    expect(
      JSON.stringify(status, (_k, v: unknown) => (typeof v === 'bigint' ? 0 : v)),
    ).not.toContain(HELIUS_KEY);
  });
});
