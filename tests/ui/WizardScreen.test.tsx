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
  await user.click(await screen.findByRole('button', { name: 'Create a new fleet' }));
}

function field(label: string | RegExp): HTMLInputElement {
  return screen.getByLabelText(label);
}

async function fillValidForm(user: UserEvent, password = PASSWORD): Promise<void> {
  await user.clear(field('Number of wallets'));
  await user.type(field('Number of wallets'), '30');
  await user.type(field('Fleet name'), 'Flota testowa');
  await user.type(field('Password'), password);
  await user.type(field('Repeat the password'), password);
}

function createButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Create the fleet' });
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

/** Clicks "Create the fleet" and checks that nothing was sent and the form is still there. */
async function clickAndExpectNoFleet(
  user: UserEvent,
  vault: ReturnType<typeof mockVault>,
): Promise<void> {
  await user.click(createButton());
  expect(createRequests(vault)).toHaveLength(0);
  expect(screen.getByRole('heading', { name: 'New fleet wizard' })).toBeTruthy();
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('form validation', () => {
  it('wallet count must be an integer 1–100 (default 30)', async () => {
    const user = userEvent.setup();
    const vault = mockVault(LOCKED);
    renderWizard(vault);
    await openWizard(user);
    expect(field('Number of wallets').value).toBe('30');
    await fillValidForm(user);
    expect(fieldErrors()).toEqual([]);

    for (const bad of ['0', '101', '1.5', '']) {
      await user.clear(field('Number of wallets'));
      if (bad !== '') await user.type(field('Number of wallets'), bad);
      expect(fieldErrors()).toEqual([
        'The number of wallets must be a whole number from 1 to 100.',
      ]);
      await clickAndExpectNoFleet(user, vault);
    }
    for (const good of ['1', '100']) {
      await user.clear(field('Number of wallets'));
      await user.type(field('Number of wallets'), good);
      expect(fieldErrors()).toEqual([]);
    }
    await user.click(createButton());
    expect(createRequests(vault).map((r) => r.walletCount)).toEqual([100]);
  });

  it.each(['a/b', '../x', 'CON', '.ukryta'])('fleet name %j is rejected', async (name) => {
    const user = userEvent.setup();
    const vault = mockVault(LOCKED);
    renderWizard(vault);
    await openWizard(user);
    await fillValidForm(user);
    await user.clear(field('Fleet name'));
    await user.type(field('Fleet name'), name);
    expect(screen.getByText(/Invalid fleet name/u)).toBeTruthy();
    await clickAndExpectNoFleet(user, vault);
  });

  it('password needs 12 characters counted like core (graphemes after NFKC)', async () => {
    const user = userEvent.setup();
    const vault = mockVault(LOCKED);
    renderWizard(vault);
    await openWizard(user);
    await fillValidForm(user, 'Ab1!Ab1!Ab1'); // 11 characters
    expect(fieldErrors()).toEqual(['The password must have at least 12 characters (now: 11).']);
    await clickAndExpectNoFleet(user, vault);

    // 11 × "ą" in NFD is 22 code points but 11 characters
    const nfd = 'ą'.normalize('NFD').repeat(11);
    await user.clear(field('Password'));
    await user.clear(field('Repeat the password'));
    await user.type(field('Password'), nfd);
    await user.type(field('Repeat the password'), nfd);
    expect(fieldErrors()).toEqual(['The password must have at least 12 characters (now: 11).']);
    await clickAndExpectNoFleet(user, vault);

    await user.type(field('Password'), 'X');
    await user.type(field('Repeat the password'), 'X');
    expect(fieldErrors()).toEqual([]);
    expect(screen.getByText(/Password strength:/u)).toBeTruthy();
    await user.click(createButton());
    expect(createRequests(vault).map((r) => r.password)).toEqual([`${nfd}X`]);
  });

  it('mismatched repeat blocks the button', async () => {
    const user = userEvent.setup();
    const vault = mockVault(LOCKED);
    renderWizard(vault);
    await openWizard(user);
    await fillValidForm(user);
    await user.type(field('Repeat the password'), 'x');
    expect(fieldErrors()).toEqual(['The passwords do not match.']);
    await clickAndExpectNoFleet(user, vault);
  });
});

describe('what blocks the fleet is always said next to the field (BUNNDLY-42)', () => {
  const SHORT = 'Ab1!Ab1!Ab1'; // 11 characters

  it('an untouched form shows no messages; a click on the button shows all of them', async () => {
    const user = userEvent.setup();
    const vault = mockVault(LOCKED);
    renderWizard(vault);
    await openWizard(user);
    expect(fieldErrors()).toEqual([]);
    expect(createButton().disabled).toBe(false);

    await clickAndExpectNoFleet(user, vault);
    expect(fieldErrors()).toEqual([
      'Enter a fleet name.',
      'The password must have at least 12 characters (now: 0).',
      'Repeat the password.',
    ]);
    // the first field to fix has the focus and points at its message
    const name = field('Fleet name');
    expect(document.activeElement).toBe(name);
    expect(name.getAttribute('aria-invalid')).toBe('true');
    const describedBy = name.getAttribute('aria-describedby') ?? '';
    expect(document.getElementById(describedBy)?.textContent).toBe('Enter a fleet name.');
  });

  it('leaving an empty field shows its message without touching the others', async () => {
    const user = userEvent.setup();
    renderWizard(mockVault(LOCKED));
    await openWizard(user);
    await user.click(field('Fleet name'));
    await user.tab();
    expect(fieldErrors()).toEqual(['Enter a fleet name.']);
    await user.tab(); // leaves "Password"
    expect(fieldErrors()).toEqual([
      'Enter a fleet name.',
      'The password must have at least 12 characters (now: 0).',
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
        await user.clear(field('Number of wallets'));
      },
      message: 'The number of wallets must be a whole number from 1 to 100.',
      focused: 'Number of wallets',
    },
    {
      title: 'empty fleet name',
      breakIt: async (user) => {
        await user.clear(field('Fleet name'));
      },
      message: 'Enter a fleet name.',
      focused: 'Fleet name',
    },
    {
      title: 'password under 12 characters',
      breakIt: async (user) => {
        await user.clear(field('Password'));
        await user.clear(field('Repeat the password'));
        await user.type(field('Password'), SHORT);
        await user.type(field('Repeat the password'), SHORT);
      },
      message: 'The password must have at least 12 characters (now: 11).',
      focused: 'Password',
    },
    {
      title: 'empty password repeat',
      breakIt: async (user) => {
        await user.clear(field('Repeat the password'));
      },
      message: 'Repeat the password.',
      focused: 'Repeat the password',
    },
    {
      title: 'different password repeat',
      breakIt: async (user) => {
        await user.type(field('Repeat the password'), 'x');
      },
      message: 'The passwords do not match.',
      focused: 'Repeat the password',
    },
    {
      title: 'import chosen but no mnemonic',
      breakIt: async (user) => {
        await user.click(
          screen.getByRole('checkbox', { name: /I already have a recovery phrase/u }),
        );
      },
      message: 'Enter the recovery phrase or untick the import.',
      focused: 'Recovery phrase',
    },
    {
      title: 'mnemonic with a wrong number of words',
      breakIt: async (user) => {
        await user.click(
          screen.getByRole('checkbox', { name: /I already have a recovery phrase/u }),
        );
        await user.type(field('Recovery phrase'), 'abandon abandon abandon');
      },
      message: 'The recovery phrase must have 12, 15, 18, 21 or 24 words (now: 3).',
      focused: 'Recovery phrase',
    },
  ];

  it.each(conditions)(
    'only $title is wrong: its message, no fleet',
    async ({ breakIt, message, focused }) => {
      const user = userEvent.setup();
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
    const user = userEvent.setup();
    const { vault, gate, seen } = vaultWithPendingCreate();
    renderWizard(vault);
    await openWizard(user);
    await user.clear(field('Number of wallets'));
    await user.type(field('Number of wallets'), '7');
    await user.type(field('Fleet name'), 'Moja flota');
    await user.type(field('Password'), PASSWORD);
    await user.type(field('Repeat the password'), PASSWORD);
    expect(fieldErrors()).toEqual([]);
    await user.click(createButton());
    gate.resolve();
    await screen.findByRole('heading', { name: 'Fleet created' });
    expect(seen).toEqual([
      { type: 'create', fleetName: 'Moja flota', walletCount: 7, password: PASSWORD },
    ]);
  });

  it('12 words, a name and a 12-character password create the fleet; without the name they do not', async () => {
    const twelve = 'Ab1!Ab1!Ab1!';
    const user = userEvent.setup();
    const { vault, gate, seen } = vaultWithPendingCreate();
    renderWizard(vault);
    await openWizard(user);
    await user.type(field('Password'), twelve);
    await user.type(field('Repeat the password'), twelve);
    await user.click(screen.getByRole('checkbox', { name: /I already have a recovery phrase/u }));
    await user.type(field('Recovery phrase'), MNEMONIC_12);

    await clickAndExpectNoFleet(user, vault);
    expect(fieldErrors()).toEqual(['Enter a fleet name.']);
    expect(document.activeElement).toBe(field('Fleet name'));

    await user.type(field('Fleet name'), 'Flota testowa');
    expect(fieldErrors()).toEqual([]);
    await user.click(createButton());
    gate.resolve();
    await screen.findByRole('heading', { name: 'Fleet created' });
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
    const user = userEvent.setup();
    renderWizard(mockVault(LOCKED));
    await openWizard(user);
    const hint = screen.getByText(/The import is optional/u).textContent;
    expect(hint).toContain('the app generates a new recovery phrase (24 words)');
    expect(hint).toContain('Phantom');
    expect(hint).toContain("m/44'/501'/{i}'/0'");
  });
});

describe('mnemonic import', () => {
  it('needs 12–24 words, can be shown, and is sent to the worker', async () => {
    const user = userEvent.setup();
    const { vault, gate, seen } = vaultWithPendingCreate();
    renderWizard(vault);
    await openWizard(user);
    await fillValidForm(user);
    await user.click(screen.getByRole('checkbox', { name: /I already have a recovery phrase/u }));
    const input = field('Recovery phrase');
    expect(input.type).toBe('password');
    await user.click(screen.getByRole('button', { name: 'Show' }));
    expect(input.type).toBe('text');
    await user.click(screen.getByRole('button', { name: 'Hide' }));
    expect(input.type).toBe('password');

    await user.type(input, 'abandon abandon abandon');
    expect(screen.getByText(/12, 15, 18, 21 or 24 words \(now: 3\)/u)).toBeTruthy();
    await clickAndExpectNoFleet(user, vault);

    await user.clear(input);
    await user.type(input, MNEMONIC_12);
    expect(fieldErrors()).toEqual([]);
    await user.click(createButton());
    expect(seen[0]?.mnemonic).toBe(MNEMONIC_12);
    gate.resolve();
    expect(await screen.findByRole('heading', { name: 'Fleet created' })).toBeTruthy();
  });

  it.each([
    ['a bad checksum', `${'abandon '.repeat(11)}abandon`],
    ['a word outside the list', `${'abandon '.repeat(11)}bunndly`],
  ])(
    'a mnemonic with %s rejected by the worker shows an English message and empties the secrets',
    async (_title, phrase) => {
      const user = userEvent.setup();
      const vault = mockVault(LOCKED, () => Promise.reject(new AppError('INVALID_MNEMONIC')));
      renderWizard(vault);
      await openWizard(user);
      await fillValidForm(user);
      await user.click(screen.getByRole('checkbox', { name: /I already have a recovery phrase/u }));
      await user.type(field('Recovery phrase'), phrase);
      await user.click(createButton());
      expect((await screen.findByRole('alert')).textContent).toContain('Invalid recovery phrase');
      expect(screen.getByRole('heading', { name: 'New fleet wizard' })).toBeTruthy();
      expect(createRequests(vault).map((r) => r.mnemonic)).toEqual([phrase]);
      expect(field('Password').value).toBe('');
      expect(field('Repeat the password').value).toBe('');
      expect(field('Recovery phrase').value).toBe('');
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
    const user = userEvent.setup();
    const vault = mockVault(LOCKED, () => Promise.reject(new AppError('INVALID_MNEMONIC')));
    renderWizard(vault);
    await openWizard(user);
    await fillValidForm(user);
    await user.click(screen.getByRole('checkbox', { name: /I already have a recovery phrase/u }));
    await user.type(field('Recovery phrase'), MNEMONIC_12);
    await user.click(createButton());
    await screen.findByRole('alert');

    // the worker got the secrets ...
    const sent = vault.request.mock.calls.find(([r]) => r.type === 'create')?.[0] as CreateRequest;
    expect(sent.password).toBe(PASSWORD);
    expect(sent.mnemonic).toBe(MNEMONIC_12);
    // ... and the form no longer holds them
    expect(field('Password').value).toBe('');
    expect(field('Repeat the password').value).toBe('');
    expect(field('Recovery phrase').value).toBe('');
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

    expect(screen.getByRole('heading', { name: 'Creating the fleet…' })).toBeTruthy();
    const bar = screen.getByRole('progressbar', { name: 'Encryption progress' });
    expect(bar.getAttribute('value')).toBe('30');
    expect(screen.getByText('30%')).toBeTruthy();
    // the page still reacts to input while scrypt runs in the worker
    await user.click(screen.getByRole('heading', { name: 'Creating the fleet…' }));
    gate.resolve();
    expect(await screen.findByRole('heading', { name: 'Fleet created' })).toBeTruthy();
  });

  it('saves only when the user clicks “Save the fleet file”', async () => {
    const user = userEvent.setup();
    const { vault, gate } = vaultWithPendingCreate();
    const storage = renderWizard(vault);
    await openWizard(user);
    await fillValidForm(user);
    await user.click(createButton());
    gate.resolve();
    await screen.findByRole('heading', { name: 'Fleet created' });
    // creation finished: nothing saved automatically
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(storage.showDirectoryPicker).not.toHaveBeenCalled();
    expect(screen.getByText(/is not saved yet/u)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Save the fleet file' }));
    expect(await screen.findByRole('heading', { name: 'Fleet file saved' })).toBeTruthy();
    expect(storage.showDirectoryPicker).toHaveBeenCalledTimes(1);
    expect(storage.files.get('Flota testowa.keystore.json')).toBe('{"version":1,"encrypted":true}');
    expect(screen.getByText('Flota testowa.keystore.json')).toBeTruthy();
    expect(
      screen.getByText(
        /Without the password and without the recovery phrase the funds\s+of this fleet cannot be recovered/u,
      ),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain('abandon');

    await user.click(screen.getByRole('button', { name: 'Go to the fleet' }));
    expect(await screen.findByRole('heading', { name: 'Fleet' })).toBeTruthy();
  });

  it('download mode asks to check the Downloads folder', async () => {
    const user = userEvent.setup();
    const { vault, gate } = vaultWithPendingCreate();
    const storage = renderWizard(vault, mockStorage('download'));
    await openWizard(user);
    await fillValidForm(user);
    await user.click(createButton());
    gate.resolve();
    expect(await screen.findByText(/Then check the “Downloads” folder/u)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save the fleet file' }));
    expect(await screen.findByText(/The file was downloaded/u)).toBeTruthy();
    expect(storage.clickDownload).toHaveBeenCalledWith('blob:fake', 'Flota testowa.keystore.json');
  });

  it('a save error is shown in English and the file can be saved again', async () => {
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
    await user.click(await screen.findByRole('button', { name: 'Save the fleet file' }));
    expect((await screen.findByRole('alert')).textContent).toContain('choice was cancelled');
    await user.click(screen.getByRole('button', { name: 'Save the fleet file' }));
    expect(await screen.findByRole('heading', { name: 'Fleet file saved' })).toBeTruthy();
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
    await screen.findByRole('heading', { name: 'Fleet created' });
  }

  it('leaving the wizard with an unsaved file asks first', async () => {
    const user = userEvent.setup();
    const { vault, gate } = vaultWithPendingCreate();
    await createdButNotSaved(user, vault, gate);
    // the vault is unlocked now, but the app does not jump to the fleet screen
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Lock' })).toBeTruthy();
    });
    expect(screen.getByRole('heading', { name: 'Fleet created' })).toBeTruthy();

    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    await user.click(screen.getByRole('button', { name: 'Fleet' }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { name: 'Fleet created' })).toBeTruthy();

    confirm.mockReturnValueOnce(true);
    await user.click(screen.getByRole('button', { name: 'Fleet' }));
    expect(screen.getByRole('heading', { name: 'Fleet' })).toBeTruthy();
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
    await screen.findByRole('heading', { name: 'Fleet created' });
    await screen.findByRole('button', { name: 'Lock' });
    vault.setStatus(LOCKED);
    expect((await screen.findByRole('alert')).textContent).toContain('locked automatically');
    expect(screen.getByRole('heading', { name: 'Fleet created' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save the fleet file' }));
    expect(await screen.findByRole('heading', { name: 'Fleet file saved' })).toBeTruthy();
  });
});
