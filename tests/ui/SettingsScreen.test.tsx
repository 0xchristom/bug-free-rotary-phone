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
  } as VaultClient;
  const storage = mockStorage();
  render(<App vault={client} storage={storage.env} statusPollMs={60_000} />);
  const user = userEvent.setup();
  const nav = await screen.findByRole('navigation', {}, { timeout: 10_000 });
  await user.click(within(nav).getByRole('button', { name: 'Ustawienia' }));
  await screen.findByRole('heading', { name: 'Ustawienia' });
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
  return screen.getByRole('button', { name: 'Zapisz ustawienia' });
}

async function saveSettings(user: UserEvent): Promise<void> {
  await user.click(saveButton());
  await screen.findByRole('button', { name: 'Zapisz zaktualizowany plik floty' });
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
    expect(field('Minimalna rezerwa (MIN_RESERVE_SOL)').value).toBe('0,015');
    expect(field('Maks. liczba prób na portfel').value).toBe('3');
    expect(field(/^Sufit ceny/u).value).toBe('50');
    expect(field('Okno ponawiania „no route”').value).toBe('20');
    expect(field('Odstęp ponowień: początkowy').value).toBe('500');
    expect(field('Odstęp ponowień: maksymalny').value).toBe('2000');
    expect(field('Automatyczna blokada po bezczynności').value).toBe('15');
    expect(screen.getByRole<HTMLInputElement>('radio', { name: /^Jednorazowy/u }).checked).toBe(
      true,
    );
    expect(
      screen.getByRole<HTMLSelectElement>('combobox', { name: 'Explorer transakcji' }).value,
    ).toBe('solscan');
    expect(screen.getByText(/Limit \/order: 60\/min \(1 zapytania/u)).toBeTruthy();
    expect(screen.getAllByText('Nie ustawiono.')).toHaveLength(4);
    expect(screen.queryByRole('button', { name: /^Usuń/u })).toBeNull();
  });

  it.each<[string | RegExp, string, string]>([
    [/^Sufit ceny/u, '0', 'Sufit ceny musi być liczbą całkowitą od 1 do 1000%.'],
    [/^Sufit ceny/u, '1001', 'Sufit ceny musi być liczbą całkowitą od 1 do 1000%.'],
    ['Maks. liczba prób na portfel', '11', 'Liczba prób musi być liczbą całkowitą od 1 do 10.'],
    ['Maks. liczba prób na portfel', 'trzy', 'Liczba prób musi być liczbą całkowitą od 1 do 10.'],
    [
      'Minimalna rezerwa (MIN_RESERVE_SOL)',
      '0,004',
      'Minimalna rezerwa musi wynosić od 0,005 do 1 SOL.',
    ],
    [
      'Minimalna rezerwa (MIN_RESERVE_SOL)',
      'abc',
      'Minimalna rezerwa musi wynosić od 0,005 do 1 SOL.',
    ],
    ['Okno ponawiania „no route”', '500', 'Okno „no route” musi wynosić od 1 do 120 s.'],
    [
      'Odstęp ponowień: maksymalny',
      '400',
      'Maksymalny odstęp ponowień nie może być krótszy niż początkowy.',
    ],
    [
      'Automatyczna blokada po bezczynności',
      '0',
      'Automatyczna blokada musi wynosić od 1 do 120 minut.',
    ],
  ])('%s = %s → Polish message, save disabled', async (label, value, message) => {
    const { user } = await setup();
    await retype(user, label, value);
    expect(screen.getByText(message)).toBeTruthy();
    expect(saveButton().disabled).toBe(true);
  });

  it('Jupiter plan sets the limit; "Własny" lets the user type it', async () => {
    const { user } = await setup();
    const plan = screen.getByRole('combobox', { name: 'Plan Jupitera' });
    await user.selectOptions(plan, 'developer');
    expect(screen.getByText(/Limit \/order: 600\/min \(10 zapytania/u)).toBeTruthy();
    await user.selectOptions(plan, 'keyless');
    expect(screen.getByText(/Limit \/order: 30\/min \(0,5 zapytania/u)).toBeTruthy();
    await user.selectOptions(plan, 'custom');
    await retype(user, 'Limit /order (zapytań na minutę)', '0');
    expect(screen.getByText(/od 1 do 100 000 zapytań na minutę/u)).toBeTruthy();
    await retype(user, 'Limit /order (zapytań na minutę)', '1200');
    expect(saveButton().disabled).toBe(false);
  });

  it('continuous mode needs confirming the warning', async () => {
    const { user } = await setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    const continuous = screen.getByRole<HTMLInputElement>('radio', { name: /^Ciągły/u });
    await user.click(continuous);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(continuous.checked).toBe(false);
    confirm.mockReturnValueOnce(true);
    await user.click(continuous);
    expect(continuous.checked).toBe(true);
    expect(screen.getByText(/Tryb ciągły jest włączony/u)).toBeTruthy();
  });
});

describe('saving', () => {
  it('saves settings in the vault and the file; they come back after reopening', async () => {
    const { handler, storage, user } = await setup();
    await retype(user, 'Minimalna rezerwa (MIN_RESERVE_SOL)', '0,02');
    await retype(user, 'Maks. liczba prób na portfel', '5');
    await retype(user, /^Sufit ceny/u, '120');
    await retype(user, 'Okno ponawiania „no route”', '30');
    await retype(user, 'Odstęp ponowień: początkowy', '250');
    await retype(user, 'Odstęp ponowień: maksymalny', '4000');
    await retype(user, 'Automatyczna blokada po bezczynności', '30');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Explorer transakcji' }), 'orb');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Plan Jupitera' }), 'launch');
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
    expect(screen.getByText('Automatyczna blokada po 30 min bezczynności')).toBeTruthy();
    expect(screen.getByText(/plik floty nie jest jeszcze zaktualizowany/u)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Zapisz zaktualizowany plik floty' }));
    await screen.findByText(`Zapisano plik ${FILE_NAME} z nowymi ustawieniami.`);
    const saved = storage.files.get(FILE_NAME);
    if (saved === undefined) throw new Error('not saved');
    const reopened = await openKeystore(parseKeystoreFile(saved), PASSWORD);
    expect(reopened.secrets.settings.global).toEqual(expected);
  });

  it('typed keys go to the worker only; the form is cleared and shows "Ustawiony."', async () => {
    const { handler, user, requests } = await setup();
    await user.type(field('Klucz API Helius'), HELIUS_KEY);
    await user.type(field('Klucz API Jupiter'), JUPITER_KEY);
    // "Pokaż" shows only the text typed now
    expect(field('Klucz API Helius').type).toBe('password');
    await user.click(
      screen.getByRole('button', { name: 'Pokaż wpisywany tekst: Klucz API Helius' }),
    );
    expect(field('Klucz API Helius').type).toBe('text');
    await saveSettings(user);

    expect(keysIn(handler)).toEqual({ helius: HELIUS_KEY, jupiter: JUPITER_KEY });
    expect(requests.at(-2)).toMatchObject({
      type: 'saveSettings',
      apiKeys: { helius: HELIUS_KEY, jupiter: JUPITER_KEY },
    });
    expect(field('Klucz API Helius').value).toBe('');
    expect(field('Klucz API Helius').type).toBe('password');
    expect(field('Klucz API Jupiter').value).toBe('');
    expect(screen.getAllByText('Ustawiony.')).toHaveLength(2);
    expect(document.body.innerHTML).not.toContain(HELIUS_KEY);
    expect(document.body.innerHTML).not.toContain(JUPITER_KEY);
  });

  it('an empty field keeps the key; "Usuń" removes it', async () => {
    const { handler, storage, user } = await setup();
    // later saves overwrite the same file
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await user.type(field('Klucz API Helius'), HELIUS_KEY);
    await user.type(field('Klucz API Jupiter'), JUPITER_KEY);
    await saveSettings(user);
    await user.click(screen.getByRole('button', { name: 'Zapisz zaktualizowany plik floty' }));
    await screen.findByText(/z nowymi ustawieniami/u);

    // nothing typed: keys stay
    await retype(user, 'Maks. liczba prób na portfel', '4');
    await saveSettings(user);
    expect(keysIn(handler)).toEqual({ helius: HELIUS_KEY, jupiter: JUPITER_KEY });
    await user.click(screen.getByRole('button', { name: 'Zapisz zaktualizowany plik floty' }));
    await screen.findByText(/z nowymi ustawieniami/u);

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('już istnieje'));
    expect(storage.files.size).toBe(1);

    await user.click(screen.getByRole('button', { name: 'Usuń: Klucz API Jupiter' }));
    expect(screen.getByText('Zostanie usunięty po zapisaniu ustawień.')).toBeTruthy();
    expect(field('Klucz API Jupiter').disabled).toBe(true);
    await saveSettings(user);
    expect(keysIn(handler)).toEqual({ helius: HELIUS_KEY });
    expect(screen.getAllByText('Ustawiony.')).toHaveLength(1);
  });

  it('a custom RPC URL must be a Helius address (CSP); a good one is write-only too', async () => {
    const { handler, user } = await setup();
    const rpc = 'Własny URL RPC (HTTPS, opcjonalnie)';
    for (const bad of [
      'https://rpc.example.com/?api-key=k1',
      'https://helius-rpc.com.evil.example/?api-key=k1',
      'https://evilhelius-rpc.com/?api-key=k1',
    ]) {
      await retype(user, rpc, bad);
      expect(
        screen.getByText(
          'Dozwolone są tylko adresy Helius w domenie helius-rpc.com (np. https://mainnet.helius-rpc.com/?api-key=…).',
        ),
      ).toBeTruthy();
      expect(saveButton().disabled).toBe(true);
    }
    await retype(user, rpc, 'http://mainnet.helius-rpc.com');
    expect(screen.getByText('Adres musi zaczynać się od https://.')).toBeTruthy();
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
    await user.type(field('Klucz API Helius'), HELIUS_KEY);
    await saveSettings(user);
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length + sessionStorage.length).toBe(0);
    expect(window.location.href).toBe(href);
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });

  it('locking with settings not written to the file asks first', async () => {
    const { user } = await setup();
    await retype(user, 'Maks. liczba prób na portfel', '4');
    await saveSettings(user);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    await user.click(screen.getByRole('button', { name: 'Zablokuj' }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { name: 'Ustawienia' })).toBeTruthy();
  });
});

describe('VaultInfo in the UI', () => {
  it('has only flags for the keys', async () => {
    const { handler, user } = await setup();
    await user.type(field('Klucz API Helius'), HELIUS_KEY);
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
