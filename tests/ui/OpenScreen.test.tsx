// @vitest-environment jsdom
/**
 * Opening a keystore (BUNNDLY-10) against the real vault handler and files built by core.
 * Only the worker's message port is skipped: the client calls the handler directly.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ERROR_MESSAGES } from '../../src/core/errors.ts';
import {
  buildKeystore,
  createKeystore,
  openKeystore,
  parseKeystoreFile,
  serializeKeystoreFile,
  type KeystoreFileV1,
} from '../../src/core/index.ts';
import { App } from '../../src/ui/App.tsx';
import { createVaultHandler, type VaultHandler } from '../../src/worker/vault.ts';
import type { VaultClient } from '../../src/worker/vault-client.ts';
import { mockStorage } from './fakes.ts';

const PASSWORD = 'zielony Kot, 7 krzeseł; drabina';
const MNEMONIC = `${'abandon '.repeat(11)}about`;
const FILE_NAME = 'Flota testowa.keystore.json';

/** 3 wallets, custom labels for 0 and 1, max spend for wallet 1. */
let fixture: KeystoreFileV1;
let fixtureText: string;

beforeAll(async () => {
  const opened = await createKeystore({
    fleetName: 'Flota testowa',
    walletCount: 3,
    password: PASSWORD,
    mnemonic: MNEMONIC,
  });
  fixture = await buildKeystore(
    {
      ...opened.secrets,
      settings: { ...opened.secrets.settings, maxSpend: [{ index: 1, lamports: 5_000_000n }] },
    },
    {
      fleetName: 'Flota testowa',
      labels: new Map([
        [0, 'Alfa'],
        [1, 'Beta'],
      ]),
    },
    PASSWORD,
  );
  fixtureText = serializeKeystoreFile(fixture);
}, 60_000);

function realClient(handler: VaultHandler): VaultClient {
  return {
    request: (request, options) => handler.handle(request, options),
  } as VaultClient;
}

function setup(fileText = fixtureText) {
  const handler = createVaultHandler();
  const storage = mockStorage();
  storage.offerFile({ name: FILE_NAME, text: fileText });
  render(<App vault={realClient(handler)} storage={storage.env} statusPollMs={60_000} />);
  return { handler, storage, user: userEvent.setup() };
}

async function openPreview(user: UserEvent): Promise<void> {
  await user.click(await screen.findByRole('button', { name: 'Otwórz plik floty' }));
  await user.click(screen.getByRole('button', { name: 'Wybierz plik floty' }));
  await screen.findByRole('heading', { name: 'Podgląd floty' });
}

/** scrypt in unlock takes about a second, longer under a loaded test run. */
const SCRYPT_WAIT = { timeout: 20_000 };

function findFleet(): Promise<HTMLElement> {
  return screen.findByRole('heading', { name: 'Flota' }, SCRYPT_WAIT);
}

function findAlert(): Promise<HTMLElement> {
  return screen.findByRole('alert', {}, SCRYPT_WAIT);
}

function passwordField(): HTMLInputElement {
  return screen.getByLabelText('Hasło');
}

async function unlockWith(user: UserEvent, password: string): Promise<void> {
  await user.type(passwordField(), password);
  await user.click(screen.getByRole('button', { name: 'Odblokuj' }));
}

function rows(): HTMLElement[] {
  return within(screen.getByRole('table')).getAllByRole('row').slice(1);
}

/** Swaps the public addresses of wallets 0 and 1, like an attacker editing the file. */
function swappedAddresses(): string {
  const raw = JSON.parse(fixtureText) as { public: { wallets: { address: string }[] } };
  const [a, b] = raw.public.wallets;
  if (!a || !b) throw new Error('fixture');
  [a.address, b.address] = [b.address, a.address];
  return JSON.stringify(raw, null, 2);
}

vi.setConfig({ testTimeout: 60_000 });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('preview without the password', () => {
  it('shows name, count, labels and unverified addresses; copy and QR are disabled', async () => {
    const { handler, user } = setup();
    await openPreview(user);

    expect(screen.getByText('Flota testowa')).toBeTruthy();
    expect(screen.getByText(FILE_NAME)).toBeTruthy();
    const list = rows();
    expect(list).toHaveLength(3);
    fixture.public.wallets.forEach((w, i) => {
      const row = list[i];
      if (!row) throw new Error('row');
      const cells = within(row);
      expect(cells.getByText(w.label)).toBeTruthy();
      expect(cells.getByText(w.address)).toBeTruthy();
      expect(cells.getByText('niezweryfikowany')).toBeTruthy();
      expect(cells.getByRole<HTMLButtonElement>('button', { name: 'Kopiuj' }).disabled).toBe(true);
      expect(cells.getByRole<HTMLButtonElement>('button', { name: 'QR' }).disabled).toBe(true);
    });
    expect(['Alfa', 'Beta', 'W03']).toEqual(fixture.public.wallets.map((w) => w.label));
    expect(screen.queryByRole('img', { name: /Kod QR/u })).toBeNull();
    // the vault stays locked: preview needs no password
    expect(handler.inspect().unlocked).toBeNull();
    expect(screen.queryByRole('button', { name: 'Zablokuj' })).toBeNull();
  });

  it('a cancelled pick shows a Polish message and stays on the pick step', async () => {
    const { storage, user } = setup();
    storage.offerFile(null);
    await user.click(await screen.findByRole('button', { name: 'Otwórz plik floty' }));
    await user.click(screen.getByRole('button', { name: 'Wybierz plik floty' }));
    expect((await findAlert()).textContent).toBe(ERROR_MESSAGES.STORAGE_CANCELLED);
  });
});

describe('error messages (files built by core)', () => {
  it('wrong password: Polish message, password cleared, still locked', async () => {
    const { handler, user } = setup();
    await openPreview(user);
    await unlockWith(user, `${PASSWORD}x`);
    expect((await findAlert()).textContent).toBe(
      ERROR_MESSAGES.KEYSTORE_WRONG_PASSWORD_OR_CORRUPTED,
    );
    expect(passwordField().value).toBe('');
    expect(handler.inspect().unlocked).toBeNull();
    expect(screen.getByRole('heading', { name: 'Podgląd floty' })).toBeTruthy();
  });

  it('a file that is not a keystore is rejected at preview', async () => {
    const { user } = setup('{"hello": "world"}');
    await user.click(await screen.findByRole('button', { name: 'Otwórz plik floty' }));
    await user.click(screen.getByRole('button', { name: 'Wybierz plik floty' }));
    expect((await findAlert()).textContent).toBe(ERROR_MESSAGES.KEYSTORE_INVALID_FORMAT);
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('a damaged ciphertext gives the wrong-password-or-corrupted message', async () => {
    const raw = JSON.parse(fixtureText) as { ciphertext: string };
    const bytes = Uint8Array.from(atob(raw.ciphertext), (c) => c.charCodeAt(0));
    bytes[10] = (bytes[10] ?? 0) ^ 1;
    raw.ciphertext = btoa(String.fromCharCode(...bytes));
    const { user } = setup(JSON.stringify(raw));
    await openPreview(user);
    await unlockWith(user, PASSWORD);
    expect((await findAlert()).textContent).toBe(
      ERROR_MESSAGES.KEYSTORE_WRONG_PASSWORD_OR_CORRUPTED,
    );
  });

  it('a swapped public address: clear warning that the file may have been replaced', async () => {
    const { handler, user } = setup(swappedAddresses());
    await openPreview(user);
    await unlockWith(user, PASSWORD);
    const alert = await findAlert();
    expect(alert.textContent).toContain('plik floty mógł zostać podmieniony');
    expect(alert.textContent).toContain(ERROR_MESSAGES.KEYSTORE_TAMPERED);
    expect(alert.textContent).toContain('Nie wysyłaj środków');
    expect(handler.inspect().unlocked).toBeNull();
    expect(passwordField().value).toBe('');
  });
});

describe('unlock', () => {
  it('shows the fleet with verified addresses; copy and QR work', async () => {
    const { handler, user } = setup();
    await openPreview(user);
    await unlockWith(user, PASSWORD);
    expect(await findFleet()).toBeTruthy();
    expect(handler.inspect().unlocked).not.toBeNull();
    expect(screen.getByText('Adresy depozytu (zweryfikowane)')).toBeTruthy();
    expect(screen.queryByText('niezweryfikowany')).toBeNull();

    const first = fixture.public.wallets[0];
    if (!first) throw new Error('fixture');
    await user.click(screen.getByRole('button', { name: 'Kopiuj adres Alfa' }));
    expect(await navigator.clipboard.readText()).toBe(first.address);
    expect(screen.getByRole('button', { name: 'Kopiuj adres Alfa' }).textContent).toBe(
      'Skopiowano',
    );

    await user.click(screen.getByRole('button', { name: 'Kod QR Alfa' }));
    expect(screen.getByRole('img', { name: `Kod QR adresu ${first.address}` })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Kod QR Alfa' }));
    expect(screen.queryByRole('img', { name: /Kod QR adresu/u })).toBeNull();
  });

  it('the password never reaches storage, the URL or the console', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m),
    );
    const href = window.location.href;
    const { user } = setup();
    await openPreview(user);
    await unlockWith(user, PASSWORD);
    await findFleet();
    expect(document.body.innerHTML).not.toContain(PASSWORD);
    expect(setItem).not.toHaveBeenCalled();
    expect(window.location.href).toBe(href);
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });
});

describe('add wallets', () => {
  async function unlocked() {
    const ctx = setup();
    await openPreview(ctx.user);
    await unlockWith(ctx.user, PASSWORD);
    await findFleet();
    return ctx;
  }

  it('keeps addresses, labels and settings; the saved file opens with the same password', async () => {
    const { storage, user } = await unlocked();
    const count = screen.getByLabelText<HTMLInputElement>('Liczba nowych portfeli');
    await user.clear(count);
    await user.type(count, '2');
    await user.click(screen.getByRole('button', { name: 'Dodaj portfele' }));

    await waitFor(() => {
      expect(rows()).toHaveLength(5);
    });
    expect(screen.getByText(/nie jest jeszcze zapisany/u)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Zapisz zaktualizowany plik floty' }));
    await screen.findByText(/z nowymi portfelami/u);

    const saved = storage.files.get(FILE_NAME);
    if (saved === undefined) throw new Error('file not saved');
    const reopened = await openKeystore(parseKeystoreFile(saved), PASSWORD);
    const wallets = reopened.file.public.wallets;
    expect(wallets).toHaveLength(5);
    expect(wallets.slice(0, 3)).toEqual(fixture.public.wallets);
    expect(wallets.map((w) => w.label)).toEqual(['Alfa', 'Beta', 'W03', 'W04', 'W05']);
    expect(wallets.map((w) => w.index)).toEqual([0, 1, 2, 3, 4]);
    expect(reopened.secrets.settings.maxSpend).toEqual([{ index: 1, lamports: 5_000_000n }]);
    expect(reopened.secrets.mnemonic).toBe(MNEMONIC);
  }, 30_000);

  it('limits the count to 100 wallets in total', async () => {
    const { user } = await unlocked();
    const count = screen.getByLabelText<HTMLInputElement>('Liczba nowych portfeli');
    await user.clear(count);
    await user.type(count, '98');
    expect(
      screen.getByText('Możesz dodać od 1 do 97 portfeli (łącznie najwyżej 100).'),
    ).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Dodaj portfele' }).disabled).toBe(
      true,
    );
    await user.clear(count);
    await user.type(count, '97');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Dodaj portfele' }).disabled).toBe(
      false,
    );
  });

  it('locking with unsaved new wallets asks first', async () => {
    const { handler, user } = await unlocked();
    await user.click(screen.getByRole('button', { name: 'Dodaj portfele' }));
    await screen.findByText(/nie jest jeszcze zapisany/u);

    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    await user.click(screen.getByRole('button', { name: 'Zablokuj' }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(handler.inspect().unlocked).not.toBeNull();

    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);

    confirm.mockReturnValueOnce(true);
    await user.click(screen.getByRole('button', { name: 'Zablokuj' }));
    expect(await screen.findByRole('heading', { name: 'Witaj w Bunndly' })).toBeTruthy();
    expect(handler.inspect().unlocked).toBeNull();
    // nothing left to protect after the lock (the listener goes in a later effect)
    await waitFor(() => {
      const after = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(after);
      expect(after.defaultPrevented).toBe(false);
    });
  });
});
