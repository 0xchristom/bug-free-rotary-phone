// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/core/errors.ts';
import { App } from '../../src/ui/App.tsx';
import type { VaultRequest } from '../../src/worker/protocol.ts';
import type { VaultRequestOptions } from '../../src/worker/vault-client.ts';
import { LOCKED, fleetInfo, mockStorage, mockVault } from './fakes.ts';
import { setupUser } from './user.ts';

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

function createRequests(vault: ReturnType<typeof mockVault>): CreateRequest[] {
  return vault.request.mock.calls
    .map(([request]) => request)
    .filter((request): request is CreateRequest => request.type === 'create');
}

/** Texts of the messages shown next to the fields, in screen order. */
function fieldErrors(): string[] {
  return Array.from(document.querySelectorAll('.field-error'), (el) => el.textContent);
}

/** Clicks "Utwórz flotę" and checks that nothing was sent and the form is still there. */
async function clickAndExpectNoFleet(
  user: UserEvent,
  vault: ReturnType<typeof mockVault>,
): Promise<void> {
  await user.click(createButton());
  expect(createRequests(vault)).toHaveLength(0);
  expect(screen.getByRole('heading', { name: 'Kreator nowej floty' })).toBeTruthy();
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('form validation', () => {
  it('wallet count must be an integer 1–100 (default 30)', async () => {
    const user = setupUser();
    const vault = mockVault(LOCKED);
    renderWizard(vault);
    await openWizard(user);
    expect(field('Liczba portfeli').value).toBe('30');
    await fillValidForm(user);
    expect(fieldErrors()).toEqual([]);

    for (const bad of ['0', '101', '1.5', '']) {
      await user.clear(field('Liczba portfeli'));
      if (bad !== '') await user.type(field('Liczba portfeli'), bad);
      expect(fieldErrors()).toEqual(['Liczba portfeli musi być liczbą całkowitą od 1 do 100.']);
      await clickAndExpectNoFleet(user, vault);
    }
    for (const good of ['1', '100']) {
      await user.clear(field('Liczba portfeli'));
      await user.type(field('Liczba portfeli'), good);
      expect(fieldErrors()).toEqual([]);
    }
    await user.click(createButton());
    expect(createRequests(vault).map((r) => r.walletCount)).toEqual([100]);
  });

  it.each(['a/b', '../x', 'CON', '.ukryta'])('fleet name %j is rejected', async (name) => {
    const user = setupUser();
    const vault = mockVault(LOCKED);
    renderWizard(vault);
    await openWizard(user);
    await fillValidForm(user);
    await user.clear(field('Nazwa floty'));
    await user.type(field('Nazwa floty'), name);
    expect(screen.getByText(/Nieprawidłowa nazwa floty/u)).toBeTruthy();
    await clickAndExpectNoFleet(user, vault);
  });

  it('password needs 12 characters counted like core (graphemes after NFKC)', async () => {
    const user = setupUser();
    const vault = mockVault(LOCKED);
    renderWizard(vault);
    await openWizard(user);
    await fillValidForm(user, 'Ab1!Ab1!Ab1'); // 11 characters
    expect(fieldErrors()).toEqual(['Hasło musi mieć co najmniej 12 znaków (teraz: 11).']);
    await clickAndExpectNoFleet(user, vault);

    // 11 × "ą" in NFD is 22 code points but 11 characters
    const nfd = 'ą'.normalize('NFD').repeat(11);
    await user.clear(field('Hasło'));
    await user.clear(field('Powtórz hasło'));
    await user.type(field('Hasło'), nfd);
    await user.type(field('Powtórz hasło'), nfd);
    expect(fieldErrors()).toEqual(['Hasło musi mieć co najmniej 12 znaków (teraz: 11).']);
    await clickAndExpectNoFleet(user, vault);

    await user.type(field('Hasło'), 'X');
    await user.type(field('Powtórz hasło'), 'X');
    expect(fieldErrors()).toEqual([]);
    expect(screen.getByText(/Siła hasła:/u)).toBeTruthy();
    await user.click(createButton());
    expect(createRequests(vault).map((r) => r.password)).toEqual([`${nfd}X`]);
  });

  it('mismatched repeat blocks the button', async () => {
    const user = setupUser();
    const vault = mockVault(LOCKED);
    renderWizard(vault);
    await openWizard(user);
    await fillValidForm(user);
    await user.type(field('Powtórz hasło'), 'x');
    expect(fieldErrors()).toEqual(['Hasła nie są takie same.']);
    await clickAndExpectNoFleet(user, vault);
  });
});

describe('what blocks the fleet is always said next to the field (BUNNDLY-42)', () => {
  const SHORT = 'Ab1!Ab1!Ab1'; // 11 characters

  it('an untouched form shows no messages; a click on the button shows all of them', async () => {
    const user = setupUser();
    const vault = mockVault(LOCKED);
    renderWizard(vault);
    await openWizard(user);
    expect(fieldErrors()).toEqual([]);
    expect(createButton().disabled).toBe(false);

    await clickAndExpectNoFleet(user, vault);
    expect(fieldErrors()).toEqual([
      'Podaj nazwę floty.',
      'Hasło musi mieć co najmniej 12 znaków (teraz: 0).',
      'Powtórz hasło.',
    ]);
    // the first field to fix has the focus and points at its message
    const name = field('Nazwa floty');
    expect(document.activeElement).toBe(name);
    expect(name.getAttribute('aria-invalid')).toBe('true');
    const describedBy = name.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.textContent).toBe('Podaj nazwę floty.');
  });

  it('leaving an empty field shows its message without touching the others', async () => {
    const user = setupUser();
    renderWizard(mockVault(LOCKED));
    await openWizard(user);
    await user.click(field('Nazwa floty'));
    await user.tab();
    expect(fieldErrors()).toEqual(['Podaj nazwę floty.']);
    await user.tab(); // leaves "Hasło"
    expect(fieldErrors()).toEqual([
      'Podaj nazwę floty.',
      'Hasło musi mieć co najmniej 12 znaków (teraz: 0).',
    ]);
  });

  interface OneCondition {
    readonly title: string;
    readonly breakIt: (user: UserEvent) => Promise<void>;
    readonly message: string;
    readonly focused: string;
  }
  const conditions: OneCondition[] = [
    {
      title: 'wallet count',
      breakIt: async (user) => {
        await user.clear(field('Liczba portfeli'));
      },
      message: 'Liczba portfeli musi być liczbą całkowitą od 1 do 100.',
      focused: 'Liczba portfeli',
    },
    {
      title: 'empty fleet name',
      breakIt: async (user) => {
        await user.clear(field('Nazwa floty'));
      },
      message: 'Podaj nazwę floty.',
      focused: 'Nazwa floty',
    },
    {
      title: 'password under 12 characters',
      breakIt: async (user) => {
        await user.clear(field('Hasło'));
        await user.clear(field('Powtórz hasło'));
        await user.type(field('Hasło'), SHORT);
        await user.type(field('Powtórz hasło'), SHORT);
      },
      message: 'Hasło musi mieć co najmniej 12 znaków (teraz: 11).',
      focused: 'Hasło',
    },
    {
      title: 'empty password repeat',
      breakIt: async (user) => {
        await user.clear(field('Powtórz hasło'));
      },
      message: 'Powtórz hasło.',
      focused: 'Powtórz hasło',
    },
    {
      title: 'different password repeat',
      breakIt: async (user) => {
        await user.type(field('Powtórz hasło'), 'x');
      },
      message: 'Hasła nie są takie same.',
      focused: 'Powtórz hasło',
    },
    {
      title: 'import chosen but no mnemonic',
      breakIt: async (user) => {
        await user.click(screen.getByRole('checkbox', { name: /Mam już mnemonik/u }));
      },
      message: 'Wpisz mnemonik albo odznacz import.',
      focused: 'Mnemonik',
    },
    {
      title: 'mnemonic with a wrong number of words',
      breakIt: async (user) => {
        await user.click(screen.getByRole('checkbox', { name: /Mam już mnemonik/u }));
        await user.type(field('Mnemonik'), 'abandon abandon abandon');
      },
      message: 'Mnemonik musi mieć 12, 15, 18, 21 albo 24 słowa (teraz: 3).',
      focused: 'Mnemonik',
    },
  ];

  it.each(conditions)(
    'only $title is wrong: its message, no fleet',
    async ({ breakIt, message, focused }) => {
      const user = setupUser();
      const vault = mockVault(LOCKED);
      renderWizard(vault);
      await openWizard(user);
      await fillValidForm(user);
      await breakIt(user);
      await clickAndExpectNoFleet(user, vault);
      expect(fieldErrors()).toEqual([message]);
      expect(document.activeElement).toBe(field(focused));
    },
  );

  it('everything right: exactly one create request with the typed values', async () => {
    const user = setupUser();
    const { vault, gate, seen } = vaultWithPendingCreate();
    renderWizard(vault);
    await openWizard(user);
    await user.clear(field('Liczba portfeli'));
    await user.type(field('Liczba portfeli'), '7');
    await user.type(field('Nazwa floty'), 'Moja flota');
    await user.type(field('Hasło'), PASSWORD);
    await user.type(field('Powtórz hasło'), PASSWORD);
    expect(fieldErrors()).toEqual([]);
    await user.click(createButton());
    gate.resolve();
    await screen.findByRole('heading', { name: 'Flota utworzona' });
    expect(seen).toEqual([
      { type: 'create', fleetName: 'Moja flota', walletCount: 7, password: PASSWORD },
    ]);
  });

  it('12 words, a name and a 12-character password create the fleet; without the name they do not', async () => {
    const twelve = 'Ab1!Ab1!Ab1!';
    const user = setupUser();
    const { vault, gate, seen } = vaultWithPendingCreate();
    renderWizard(vault);
    await openWizard(user);
    await user.type(field('Hasło'), twelve);
    await user.type(field('Powtórz hasło'), twelve);
    await user.click(screen.getByRole('checkbox', { name: /Mam już mnemonik/u }));
    await user.type(field('Mnemonik'), MNEMONIC_12);

    await clickAndExpectNoFleet(user, vault);
    expect(fieldErrors()).toEqual(['Podaj nazwę floty.']);
    expect(document.activeElement).toBe(field('Nazwa floty'));

    await user.type(field('Nazwa floty'), 'Flota testowa');
    expect(fieldErrors()).toEqual([]);
    await user.click(createButton());
    gate.resolve();
    await screen.findByRole('heading', { name: 'Flota utworzona' });
    expect(seen).toEqual([
      {
        type: 'create',
        fleetName: 'Flota testowa',
        walletCount: 30,
        password: twelve,
        mnemonic: MNEMONIC_12,
      },
    ]);
  });

  it('says that the import is optional and what it does', async () => {
    const user = setupUser();
    renderWizard(mockVault(LOCKED));
    await openWizard(user);
    const hint = screen.getByText(/Import jest opcjonalny/u).textContent;
    expect(hint).toContain('aplikacja sama wygeneruje nowy mnemonik (24 słowa)');
    expect(hint).toContain('Phantom');
    expect(hint).toContain("m/44'/501'/{i}'/0'");
  });
});

describe('mnemonic import', () => {
  it('needs 12–24 words, can be shown, and is sent to the worker', async () => {
    const user = setupUser();
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
    await clickAndExpectNoFleet(user, vault);

    await user.clear(input);
    await user.type(input, MNEMONIC_12);
    expect(fieldErrors()).toEqual([]);
    await user.click(createButton());
    expect(seen[0]?.mnemonic).toBe(MNEMONIC_12);
    gate.resolve();
    expect(await screen.findByRole('heading', { name: 'Flota utworzona' })).toBeTruthy();
  });

  it.each([
    ['a bad checksum', `${'abandon '.repeat(11)}abandon`],
    ['a word outside the list', `${'abandon '.repeat(11)}bunndly`],
  ])(
    'a mnemonic with %s rejected by the worker shows a Polish message and empties the secrets',
    async (_title, phrase) => {
      const user = setupUser();
      const vault = mockVault(LOCKED, () => Promise.reject(new AppError('INVALID_MNEMONIC')));
      renderWizard(vault);
      await openWizard(user);
      await fillValidForm(user);
      await user.click(screen.getByRole('checkbox', { name: /Mam już mnemonik/u }));
      await user.type(field('Mnemonik'), phrase);
      await user.click(createButton());
      expect((await screen.findByRole('alert')).textContent).toContain(
        'Nieprawidłowa fraza odzyskiwania',
      );
      expect(screen.getByRole('heading', { name: 'Kreator nowej floty' })).toBeTruthy();
      expect(createRequests(vault).map((r) => r.mnemonic)).toEqual([phrase]);
      expect(field('Hasło').value).toBe('');
      expect(field('Powtórz hasło').value).toBe('');
      expect(field('Mnemonik').value).toBe('');
      // back on the form: only the worker's message, no field messages until the user acts
      expect(fieldErrors()).toEqual([]);
    },
  );
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
    const user = setupUser();
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
    const user = setupUser();
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
    const user = setupUser();
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
    const user = setupUser();
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
    const user = setupUser();
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
    const user = setupUser();
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
    const user = setupUser();
    const { vault, gate } = vaultWithPendingCreate();
    await createdButNotSaved(user, vault, gate);
    await waitFor(() => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    });
  });

  it('auto-lock does not discard the unsaved encrypted file', async () => {
    const user = setupUser();
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
