// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/core/errors.ts';
import { App } from '../../src/ui/App.tsx';
import type { VaultRequest } from '../../src/worker/protocol.ts';
import type { VaultRequestOptions } from '../../src/worker/vault-client.ts';
import { LOCKED, fleetInfo, mockStorage, mockVault } from './fakes.ts';

const PASSWORD = 'zielony Kot, 7 krzeseł; drabina';
const MNEMONIC_12 = `${'abandon '.repeat(11)}about`;

type CreateRequest = Extract<VaultRequest, { type: 'create' }>;

/** A gate the test opens with `resolve()`. */
function createGate() {
  let resolve!: () => void;
  const promise = new Promise<undefined>((res) => {
    resolve = () => {
      res(undefined);
    };
  });
  return { promise, resolve };
}

/** Vault whose `create` waits until the test resolves it, reporting 30% progress first. */
function vaultWithPendingCreate() {
  const gate = createGate();
  const seen: CreateRequest[] = [];
  let result: Promise<unknown> = Promise.resolve();
  const vault = mockVault(LOCKED, (req, options: VaultRequestOptions) => {
    seen.push(req);
    options.onProgress?.(0.3);
    result = gate.promise.then(() => ({
      fileText: '{"version":1,"encrypted":true}',
      info: fleetInfo(req.walletCount, req.fleetName),
    }));
    return result;
  });
  return { vault, gate, seen };
}

function renderWizard(vault: ReturnType<typeof mockVault>, storage = mockStorage()) {
  render(<App vault={vault.client} storage={storage.env} statusPollMs={60_000} />);
  return storage;
}

async function openWizard(user: UserEvent): Promise<void> {
  await user.click(await screen.findByRole('button', { name: 'Utwórz nową flotę' }));
}

function field(label: string | RegExp): HTMLInputElement {
  return screen.getByLabelText(label);
}

async function fillValidForm(user: UserEvent, password = PASSWORD): Promise<void> {
  await user.clear(field('Liczba portfeli'));
  await user.type(field('Liczba portfeli'), '30');
  await user.type(field('Nazwa floty'), 'Flota testowa');
  await user.type(field('Hasło'), password);
  await user.type(field('Powtórz hasło'), password);
}

function createButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Utwórz flotę' });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('form validation', () => {
  it('wallet count must be an integer 1–100 (default 30)', async () => {
    const user = userEvent.setup();
    renderWizard(mockVault(LOCKED));
    await openWizard(user);
    expect(field('Liczba portfeli').value).toBe('30');
    await fillValidForm(user);
    expect(createButton().disabled).toBe(false);

    for (const bad of ['0', '101', '1.5', '']) {
      await user.clear(field('Liczba portfeli'));
      if (bad !== '') await user.type(field('Liczba portfeli'), bad);
      expect(createButton().disabled).toBe(true);
      expect(screen.getByText(/od 1 do 100/u)).toBeTruthy();
    }
    for (const good of ['1', '100']) {
      await user.clear(field('Liczba portfeli'));
      await user.type(field('Liczba portfeli'), good);
      expect(createButton().disabled).toBe(false);
    }
  });

  it.each(['a/b', '../x', 'CON', '.ukryta'])('fleet name %j is rejected', async (name) => {
    const user = userEvent.setup();
    renderWizard(mockVault(LOCKED));
    await openWizard(user);
    await fillValidForm(user);
    await user.clear(field('Nazwa floty'));
    await user.type(field('Nazwa floty'), name);
    expect(createButton().disabled).toBe(true);
    expect(screen.getByText(/Nieprawidłowa nazwa floty/u)).toBeTruthy();
  });

  it('password needs 12 characters counted like core (graphemes after NFKC)', async () => {
    const user = userEvent.setup();
    renderWizard(mockVault(LOCKED));
    await openWizard(user);
    await fillValidForm(user, 'Ab1!Ab1!Ab1'); // 11 characters
    expect(createButton().disabled).toBe(true);
    expect(screen.getByText(/co najmniej 12 znaków \(teraz: 11\)/u)).toBeTruthy();

    // 11 × "ą" in NFD is 22 code points but 11 characters
    const nfd = 'ą'.normalize('NFD').repeat(11);
    await user.clear(field('Hasło'));
    await user.clear(field('Powtórz hasło'));
    await user.type(field('Hasło'), nfd);
    await user.type(field('Powtórz hasło'), nfd);
    expect(createButton().disabled).toBe(true);

    await user.type(field('Hasło'), 'X');
    await user.type(field('Powtórz hasło'), 'X');
    expect(createButton().disabled).toBe(false);
    expect(screen.getByText(/Siła hasła:/u)).toBeTruthy();
  });

  it('mismatched repeat blocks the button', async () => {
    const user = userEvent.setup();
    renderWizard(mockVault(LOCKED));
    await openWizard(user);
    await fillValidForm(user);
    await user.type(field('Powtórz hasło'), 'x');
    expect(screen.getByText('Hasła nie są takie same.')).toBeTruthy();
    expect(createButton().disabled).toBe(true);
  });
});

describe('mnemonic import', () => {
  it('needs 12–24 words, can be shown, and is sent to the worker', async () => {
    const user = userEvent.setup();
    const { vault, gate, seen } = vaultWithPendingCreate();
    renderWizard(vault);
    await openWizard(user);
    await fillValidForm(user);
    await user.click(screen.getByRole('checkbox', { name: /Mam już mnemonik/u }));
    const input = field('Mnemonik');
    expect(input.type).toBe('password');
    await user.click(screen.getByRole('button', { name: 'Pokaż' }));
    expect(input.type).toBe('text');
    await user.click(screen.getByRole('button', { name: 'Ukryj' }));
    expect(input.type).toBe('password');

    await user.type(input, 'abandon abandon abandon');
    expect(screen.getByText(/12, 15, 18, 21 albo 24 słowa \(teraz: 3\)/u)).toBeTruthy();
    expect(createButton().disabled).toBe(true);

    await user.clear(input);
    await user.type(input, MNEMONIC_12);
    expect(createButton().disabled).toBe(false);
    await user.click(createButton());
    expect(seen[0]?.mnemonic).toBe(MNEMONIC_12);
    gate.resolve();
    expect(await screen.findByRole('heading', { name: 'Flota utworzona' })).toBeTruthy();
  });

  it('an invalid mnemonic rejected by the worker shows a Polish message', async () => {
    const user = userEvent.setup();
    const vault = mockVault(LOCKED, () => Promise.reject(new AppError('INVALID_MNEMONIC')));
    renderWizard(vault);
    await openWizard(user);
    await fillValidForm(user);
    await user.click(screen.getByRole('checkbox', { name: /Mam już mnemonik/u }));
    await user.type(field('Mnemonik'), `${'abandon '.repeat(11)}abandon`); // bad checksum
    await user.click(createButton());
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Nieprawidłowa fraza odzyskiwania',
    );
    expect(screen.getByRole('heading', { name: 'Kreator nowej floty' })).toBeTruthy();
  });
});

describe('secrets handling', () => {
  it('clears password and mnemonic right after sending; nothing in storage, URL or console', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const pushState = vi.spyOn(window.history, 'pushState');
    const replaceState = vi.spyOn(window.history, 'replaceState');
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const href = window.location.href;
    const user = userEvent.setup();
    const vault = mockVault(LOCKED, () => Promise.reject(new AppError('INVALID_MNEMONIC')));
    renderWizard(vault);
    await openWizard(user);
    await fillValidForm(user);
    await user.click(screen.getByRole('checkbox', { name: /Mam już mnemonik/u }));
    await user.type(field('Mnemonik'), MNEMONIC_12);
    await user.click(createButton());
    await screen.findByRole('alert');

    // the worker got the secrets ...
    const sent = vault.request.mock.calls.find(([r]) => r.type === 'create')?.[0] as CreateRequest;
    expect(sent.password).toBe(PASSWORD);
    expect(sent.mnemonic).toBe(MNEMONIC_12);
    // ... and the form no longer holds them
    expect(field('Hasło').value).toBe('');
    expect(field('Powtórz hasło').value).toBe('');
    expect(field('Mnemonik').value).toBe('');
    expect(document.body.innerHTML).not.toContain('abandon');
    expect(document.body.innerHTML).not.toContain(PASSWORD);

    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length + sessionStorage.length).toBe(0);
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    expect(window.location.href).toBe(href);
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });
});

describe('creating and saving', () => {
  it('shows scrypt progress while the worker runs, the UI stays responsive', async () => {
    const user = userEvent.setup();
    const { vault, gate } = vaultWithPendingCreate();
    renderWizard(vault);
    await openWizard(user);
    await fillValidForm(user);
    await user.click(createButton());

    expect(screen.getByRole('heading', { name: 'Tworzenie floty…' })).toBeTruthy();
    const bar = screen.getByRole('progressbar', { name: 'Postęp szyfrowania' });
    expect(bar.getAttribute('value')).toBe('30');
    expect(screen.getByText('30%')).toBeTruthy();
    // the page still reacts to input while scrypt runs in the worker
    await user.click(screen.getByRole('heading', { name: 'Tworzenie floty…' }));
    gate.resolve();
    expect(await screen.findByRole('heading', { name: 'Flota utworzona' })).toBeTruthy();
  });

  it('saves only when the user clicks “Zapisz plik floty”', async () => {
    const user = userEvent.setup();
    const { vault, gate } = vaultWithPendingCreate();
    const storage = renderWizard(vault);
    await openWizard(user);
    await fillValidForm(user);
    await user.click(createButton());
    gate.resolve();
    await screen.findByRole('heading', { name: 'Flota utworzona' });
    // creation finished: nothing saved automatically
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(storage.showDirectoryPicker).not.toHaveBeenCalled();
    expect(screen.getByText(/nie jest jeszcze zapisany/u)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Zapisz plik floty' }));
    expect(await screen.findByRole('heading', { name: 'Plik floty zapisany' })).toBeTruthy();
    expect(storage.showDirectoryPicker).toHaveBeenCalledTimes(1);
    expect(storage.files.get('Flota testowa.keystore.json')).toBe('{"version":1,"encrypted":true}');
    expect(screen.getByText('Flota testowa.keystore.json')).toBeTruthy();
    expect(screen.getByText(/Bez hasła i bez mnemonika nie da się odzyskać środków/u)).toBeTruthy();
    expect(document.body.textContent).not.toContain('abandon');

    await user.click(screen.getByRole('button', { name: 'Przejdź do floty' }));
    expect(await screen.findByRole('heading', { name: 'Flota' })).toBeTruthy();
  });

  it('download mode asks to check the Downloads folder', async () => {
    const user = userEvent.setup();
    const { vault, gate } = vaultWithPendingCreate();
    const storage = renderWizard(vault, mockStorage('download'));
    await openWizard(user);
    await fillValidForm(user);
    await user.click(createButton());
    gate.resolve();
    expect(await screen.findByText(/Sprawdź potem folder „Pobrane”/u)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Zapisz plik floty' }));
    expect(await screen.findByText(/Plik został pobrany/u)).toBeTruthy();
    expect(storage.clickDownload).toHaveBeenCalledWith('blob:fake', 'Flota testowa.keystore.json');
  });

  it('a save error is shown in Polish and the file can be saved again', async () => {
    const user = userEvent.setup();
    const { vault, gate } = vaultWithPendingCreate();
    const storage = mockStorage();
    storage.showDirectoryPicker.mockImplementationOnce(() =>
      Promise.reject(new DOMException('cancelled', 'AbortError')),
    );
    renderWizard(vault, storage);
    await openWizard(user);
    await fillValidForm(user);
    await user.click(createButton());
    gate.resolve();
    await user.click(await screen.findByRole('button', { name: 'Zapisz plik floty' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Anulowano wybór');
    await user.click(screen.getByRole('button', { name: 'Zapisz plik floty' }));
    expect(await screen.findByRole('heading', { name: 'Plik floty zapisany' })).toBeTruthy();
  });
});

describe('unsaved file protection', () => {
  async function createdButNotSaved(
    user: UserEvent,
    vault: ReturnType<typeof mockVault>,
    gate: { resolve: () => void },
  ) {
    renderWizard(vault);
    await openWizard(user);
    await fillValidForm(user);
    await user.click(createButton());
    gate.resolve();
    await screen.findByRole('heading', { name: 'Flota utworzona' });
  }

  it('leaving the wizard with an unsaved file asks first', async () => {
    const user = userEvent.setup();
    const { vault, gate } = vaultWithPendingCreate();
    await createdButNotSaved(user, vault, gate);
    // the vault is unlocked now, but the app does not jump to the fleet screen
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Zablokuj' })).toBeTruthy();
    });
    expect(screen.getByRole('heading', { name: 'Flota utworzona' })).toBeTruthy();

    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    await user.click(screen.getByRole('button', { name: 'Flota' }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { name: 'Flota utworzona' })).toBeTruthy();

    confirm.mockReturnValueOnce(true);
    await user.click(screen.getByRole('button', { name: 'Flota' }));
    expect(screen.getByRole('heading', { name: 'Flota' })).toBeTruthy();
  });

  it('closing the tab with an unsaved file triggers the browser warning', async () => {
    const user = userEvent.setup();
    const { vault, gate } = vaultWithPendingCreate();
    await createdButNotSaved(user, vault, gate);
    await waitFor(() => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    });
  });

  it('auto-lock does not discard the unsaved encrypted file', async () => {
    const user = userEvent.setup();
    const { vault, gate } = vaultWithPendingCreate();
    render(<App vault={vault.client} storage={mockStorage().env} statusPollMs={20} />);
    await openWizard(user);
    await fillValidForm(user);
    await user.click(createButton());
    gate.resolve();
    await screen.findByRole('heading', { name: 'Flota utworzona' });
    await screen.findByRole('button', { name: 'Zablokuj' });
    vault.setStatus(LOCKED);
    expect((await screen.findByRole('alert')).textContent).toContain('zablokowana automatycznie');
    expect(screen.getByRole('heading', { name: 'Flota utworzona' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Zapisz plik floty' }));
    expect(await screen.findByRole('heading', { name: 'Plik floty zapisany' })).toBeTruthy();
  });
});
