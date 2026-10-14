// @vitest-environment jsdom
/** The new fleet wizard: mnemonic import, secrets, creating and saving, unsaved file protection. Setup: WizardScreen.fixture.tsx. */
import { act, render, screen, waitFor } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/core/errors.ts';
import { App } from '../../src/ui/App.tsx';
import { LOCKED, mockStorage, mockVault } from './fakes.ts';
import { setupUser } from './user.ts';
import {
  PASSWORD,
  MNEMONIC_12,
  type CreateRequest,
  vaultWithPendingCreate,
  renderWizard,
  openWizard,
  field,
  fillValidForm,
  closingTabAsks,
  createButton,
  createRequests,
  fieldErrors,
  clickAndExpectNoFleet,
} from './WizardScreen.fixture.tsx';

describe('mnemonic import', () => {
  it('needs 12–24 words, can be shown, and is sent to the worker', async () => {
    const user = setupUser();
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
      const user = setupUser();
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
    const user = setupUser();
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
    const user = setupUser();
    const { vault, gate } = vaultWithPendingCreate();
    renderWizard(vault);
    await openWizard(user);
    await fillValidForm(user);
    await user.click(createButton());

    expect(screen.getByRole('heading', { name: 'Creating the fleet…' })).toBeTruthy();
    const bar = screen.getByRole('progressbar', { name: 'Encryption progress' });
    expect(bar.getAttribute('aria-valuenow')).toBe('30');
    expect(screen.getByText('30%')).toBeTruthy();
    // the page still reacts to input while scrypt runs in the worker
    await user.click(screen.getByRole('heading', { name: 'Creating the fleet…' }));
    gate.resolve();
    expect(await screen.findByRole('heading', { name: 'Fleet created' })).toBeTruthy();
  });

  it('saves only when the user clicks “Save the fleet file”', async () => {
    const user = setupUser();
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

    // saved: the app no longer guards the file, so the button leaves without a question
    await waitFor(() => {
      expect(closingTabAsks()).toBe(false);
    });
    await user.click(screen.getByRole('button', { name: 'Go to the fleet' }));
    expect(await screen.findByRole('heading', { name: 'Fleet' })).toBeTruthy();
  });

  it('download mode asks to check the Downloads folder', async () => {
    const user = setupUser();
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
    const user = setupUser();
    const { vault, gate } = vaultWithPendingCreate();
    await createdButNotSaved(user, vault, gate);
    // the vault is unlocked now, but the app does not jump to the fleet screen
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Lock' })).toBeTruthy();
    });
    expect(screen.getByRole('heading', { name: 'Fleet created' })).toBeTruthy();
    await waitFor(() => {
      expect(closingTabAsks()).toBe(true);
    });

    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    await user.click(screen.getByRole('button', { name: 'Dashboard' }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { name: 'Fleet created' })).toBeTruthy();

    confirm.mockReturnValueOnce(true);
    await user.click(screen.getByRole('button', { name: 'Dashboard' }));
    expect(screen.getByRole('heading', { name: 'Fleet' })).toBeTruthy();
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
    await screen.findByRole('heading', { name: 'Fleet created' });
    await screen.findByRole('button', { name: 'Lock' });
    vault.setStatus(LOCKED);
    expect((await screen.findByRole('alert')).textContent).toContain('locked automatically');
    expect(screen.getByRole('heading', { name: 'Fleet created' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save the fleet file' }));
    expect(await screen.findByRole('heading', { name: 'Fleet file saved' })).toBeTruthy();
  });
});
