// @vitest-environment jsdom
/**
 * The fleet remembered on this device and the passwordless window, on screen (BUNNDLY-52),
 * against the real vault handler. The worker's IndexedDB is the in-memory stand-in from
 * tests/helpers/remember-store.ts; a "refresh" is a new handler and a new App on the same
 * store, as after reloading the page.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createKeystore, serializeKeystoreFile } from '../../src/core/index.ts';
import { App } from '../../src/ui/App.tsx';
import type { RememberStore } from '../../src/worker/remember.ts';
import { createVaultHandler, type VaultHandler } from '../../src/worker/vault.ts';
import type { VaultClient } from '../../src/worker/vault-client.ts';
import {
  failingRememberStore,
  memoryRememberStore,
  type MemoryRememberStore,
} from '../helpers/remember-store.ts';
import { mockStorage } from './fakes.ts';
import { setupUser } from './user.ts';

vi.mock('@noble/hashes/scrypt.js', () => import('../helpers/fast-kdf.ts'));

const PASSWORD = 'zielony Kot, 7 krzeseł; drabina';
const MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const FILE_NAME = 'Flota testowa.keystore.json';
const MINUTE = 60_000;

let fileText: string;

beforeAll(async () => {
  const opened = await createKeystore({
    fleetName: 'Flota testowa',
    walletCount: 3,
    password: PASSWORD,
    mnemonic: MNEMONIC,
  });
  fileText = serializeKeystoreFile(opened.file);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function client(handler: VaultHandler): VaultClient {
  return {
    request: (request, options) => handler.handle(request, options),
    onEvent: (l) => handler.onEvent(l),
  } as VaultClient;
}

/** One page load: a fresh worker on the browser's (shared) store. */
function load(store: RememberStore) {
  const handler = createVaultHandler({ remember: store });
  const storage = mockStorage();
  storage.offerFile({ name: FILE_NAME, text: fileText });
  render(<App vault={client(handler)} storage={storage.env} statusPollMs={60_000} />);
  return { handler, user: setupUser() };
}

function refresh(store: RememberStore) {
  cleanup();
  return load(store);
}

const findFleet = (): Promise<HTMLElement> => screen.findByRole('heading', { name: 'Fleet' });

async function openFile(user: UserEvent, remember = true): Promise<void> {
  await user.click(await screen.findByRole('button', { name: 'Open a fleet file' }));
  await user.click(screen.getByRole('button', { name: 'Choose a fleet file' }));
  await screen.findByRole('heading', { name: 'Fleet preview' });
  const option = screen.getByRole<HTMLInputElement>('checkbox', {
    name: 'Remember this fleet on this device',
  });
  await waitFor(() => {
    expect(option.disabled).toBe(false); // the device answered
  });
  expect(option.checked).toBe(true); // on by default
  if (!remember) await user.click(option);
  await user.type(screen.getByLabelText('Password'), PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Unlock' }));
  await findFleet();
}

describe('a refresh within the window', () => {
  it('opens the fleet without the password; nothing in localStorage or sessionStorage', async () => {
    const store = memoryRememberStore();
    const first = load(store);
    await openFile(first.user);
    const addresses = first.handler.inspect().unlocked?.publicWallets.map((w) => w.address);

    const second = refresh(store);
    await findFleet();
    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(second.handler.inspect().unlocked?.publicWallets.map((w) => w.address)).toEqual(
      addresses,
    );
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });
});

describe('the start screen of a remembered fleet', () => {
  it('after Lock asks for the password only; a wrong one says so, the right one opens', async () => {
    const store = memoryRememberStore();
    const { user } = load(store);
    await openFile(user);
    await user.click(screen.getByRole('button', { name: 'Lock' }));
    expect(await store.get('session')).toBeUndefined();

    const next = refresh(store);
    await screen.findByRole('heading', { name: 'Welcome back' });
    expect(screen.getByText('Flota testowa')).toBeTruthy();
    expect(screen.getByText(/3 wallets\) is remembered on this device/u)).toBeTruthy();
    await next.user.type(screen.getByLabelText('Password'), 'not the password at all');
    await next.user.click(screen.getByRole('button', { name: 'Unlock' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/password is wrong/u);
    expect(screen.getByLabelText<HTMLInputElement>('Password').value).toBe('');

    await next.user.type(screen.getByLabelText('Password'), PASSWORD);
    await next.user.click(screen.getByRole('button', { name: 'Unlock' }));
    await findFleet();
    expect(await store.get('session')).toBeDefined();
  });

  // BUNNDLY-83: the lock notice belongs to the locked state, not to the fleet opened again.
  it('the lock notice stays after a wrong password and goes after the right one', async () => {
    const store = memoryRememberStore();
    const { user } = load(store);
    await openFile(user);
    await user.click(screen.getByRole('button', { name: 'Lock' }));
    await screen.findByRole('heading', { name: 'Welcome back' });
    expect(screen.getByText('The fleet was locked.')).toBeTruthy();

    await user.type(screen.getByLabelText('Password'), 'not the password at all');
    await user.click(screen.getByRole('button', { name: 'Unlock' }));
    await screen.findByText(/password is wrong/u);
    expect(screen.getByText('The fleet was locked.')).toBeTruthy();

    await user.type(screen.getByLabelText('Password'), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Unlock' }));
    await findFleet();
    expect(screen.queryByText('The fleet was locked.')).toBeNull();
  });

  it('Forget this device asks first, then the start screen is the plain one', async () => {
    const store = memoryRememberStore();
    const { user } = load(store);
    await openFile(user);
    await user.click(screen.getByRole('button', { name: 'Lock' }));
    await screen.findByRole('heading', { name: 'Welcome back' });

    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    await user.click(screen.getByRole('button', { name: 'Forget this device' }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(store.keys()).toEqual(['account', 'prefs']);

    confirm.mockReturnValueOnce(true);
    await user.click(screen.getByRole('button', { name: 'Forget this device' }));
    await screen.findByRole('heading', { name: 'Welcome to Bunndly' });
    expect(store.keys()).toEqual(['prefs']);
  });

  it('opening with the option off keeps no fleet on the device', async () => {
    const store: MemoryRememberStore = memoryRememberStore();
    const { user } = load(store);
    await openFile(user, false);
    expect(store.keys()).toEqual(['prefs']);
    refresh(store);
    await screen.findByRole('heading', { name: 'Welcome to Bunndly' });
  });
});

describe('Settings, This device', () => {
  it('the window choice reaches the record; turning remembering off forgets the fleet', async () => {
    const store = memoryRememberStore();
    const { user } = load(store);
    await openFile(user);
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    const select = await screen.findByLabelText<HTMLSelectElement>(
      'Open without the password after a refresh for',
    );
    expect(select.selectedOptions[0]?.textContent).toBe('15 minutes');
    expect(screen.queryByText(/^No time limit:/u)).toBeNull();

    await user.selectOptions(select, 'No time limit');
    await waitFor(async () => {
      expect((await store.get('session'))?.expiresAt).toBeNull();
    });
    expect((await screen.findByText(/^No time limit:/u)).textContent).toBe(
      'No time limit: the fleet opens without the password until you Lock, forget this device, open another fleet file or the file fails to decrypt. The auto-lock does not end it. Anyone with access to this browser profile can open the fleet without the password.',
    );
    await user.selectOptions(select, '2 hours');
    await waitFor(async () => {
      expect(await store.get('prefs')).toEqual({ remember: true, windowMs: 120 * MINUTE });
    });
    await waitFor(() => {
      expect(screen.queryByText(/^No time limit:/u)).toBeNull(); // after the view reloads
    });
    expect(select.selectedOptions[0]?.textContent).toBe('2 hours');

    await user.click(screen.getByRole('checkbox', { name: 'Remember this fleet on this device' }));
    await waitFor(() => {
      expect(store.keys()).toEqual(['prefs']);
    });
  });
});

// BUNNDLY-80: a change not written to disk is still said after a reload.
describe('a fleet file the disk lacks, after a refresh', () => {
  const WARNING = /^The updated fleet file is not saved yet\. Only this browser holds/u;

  /** Opens the file, then changes the fleet without writing the file (a screen left or a reload). */
  async function changedNotSaved(store: MemoryRememberStore): Promise<string> {
    const { handler, user } = load(store);
    await openFile(user);
    expect(screen.queryByText(WARNING)).toBeNull(); // opened from disk: nothing to save
    const info = handler.inspect().unlocked;
    if (info === null) throw new Error('not unlocked');
    const changed = (await handler.handle({
      type: 'saveSettings',
      settings: { ...info.settings, maxSpend: [{ index: 0, lamports: 100_000_000n }] },
      apiKeys: {},
    })) as { fileText: string };
    return changed.fileText;
  }

  it('the warning comes back after the refresh; saving writes the newest file and ends it', async () => {
    const store = memoryRememberStore();
    const newest = await changedNotSaved(store);

    const next = refresh(store);
    await findFleet();
    expect((await screen.findByText(WARNING)).textContent).toBe(
      'The updated fleet file is not saved yet. Only this browser holds the latest changes: save the fleet file to keep them.',
    );
    await next.user.click(screen.getByRole('button', { name: 'Save the fleet file' }));
    await screen.findByText(`Saved ${FILE_NAME}.`);
    expect(screen.queryByText(WARNING)).toBeNull();
    expect((await store.get('account'))?.fileText).toBe(newest);
    expect((await store.get('account'))?.unsaved).toBe(false);

    refresh(store);
    await findFleet();
    await waitFor(async () => {
      expect(await store.get('session')).toBeDefined();
    });
    expect(screen.queryByText(WARNING)).toBeNull();
  });

  it('Lock and Forget this device ask with the only copy named; No keeps the fleet', async () => {
    const store = memoryRememberStore();
    await changedNotSaved(store);
    const next = refresh(store);
    await screen.findByText(WARNING);

    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(true);
    await next.user.click(screen.getByRole('button', { name: 'Lock' }));
    expect(confirm).toHaveBeenLastCalledWith(
      expect.stringMatching(/^The fleet file is not saved/u),
    );
    await screen.findByRole('heading', { name: 'Welcome back' });

    confirm.mockReturnValueOnce(false);
    await next.user.click(screen.getByRole('button', { name: 'Forget this device' }));
    await waitFor(() => {
      expect(confirm).toHaveBeenCalledTimes(2);
    });
    expect(confirm).toHaveBeenLastCalledWith(
      'The fleet file on your disk is older than this fleet, or was never saved: only this browser holds the latest changes. Forgetting this device deletes them for good. Forget anyway?',
    );
    expect(store.keys()).toEqual(['account', 'prefs']);
  });
});

// BUNNDLY-84: opening a file or creating a fleet replaces the remembered fleet (with the
// option on) or forgets it (off). While only the browser holds its changes, both ask first.
describe('another fleet over a remembered fleet the disk lacks', () => {
  const NEW_FLEET = 'Druga flota';
  const QUESTION = (doing: string): string =>
    `“Flota testowa” is remembered on this device. The fleet file on your disk is older than this fleet, or was never saved: only this browser holds the latest changes. ${doing} replaces it and deletes them for good. Continue anyway?`;
  const KEPT =
    'The remembered fleet was kept. Unlock it on the start screen and save its fleet file first.';

  /** A remembered fleet with a change only the browser has, locked: the start screen. */
  async function lockedWithChanges(store: MemoryRememberStore) {
    const { handler, user } = load(store);
    await openFile(user);
    const info = handler.inspect().unlocked;
    if (info === null) throw new Error('not unlocked');
    const changed = (await handler.handle({
      type: 'saveSettings',
      settings: { ...info.settings, maxSpend: [{ index: 0, lamports: 100_000_000n }] },
      apiKeys: {},
    })) as { fileText: string };
    const next = refresh(store);
    await screen.findByText(/^The updated fleet file is not saved yet/u);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(true); // Lock asks too
    await next.user.click(screen.getByRole('button', { name: 'Lock' }));
    await screen.findByRole('heading', { name: 'Welcome back' });
    expect(await store.get('account')).toMatchObject({ fileText: changed.fileText, unsaved: true });
    confirm.mockClear();
    return { ...next, confirm, newest: changed.fileText };
  }

  async function rememberOption(user: UserEvent, on: boolean): Promise<void> {
    const option = screen.getByRole<HTMLInputElement>('checkbox', {
      name: 'Remember this fleet on this device',
    });
    await waitFor(() => {
      expect(option.disabled).toBe(false);
    });
    if (option.checked !== on) await user.click(option);
    expect(option.checked).toBe(on);
  }

  it.each([true, false])(
    'opening another file (remember %s) asks; No sends nothing and keeps the record',
    async (remember) => {
      const store = memoryRememberStore();
      const { handler, user, confirm, newest } = await lockedWithChanges(store);
      await user.click(screen.getByRole('button', { name: 'Open another fleet file' }));
      await user.click(screen.getByRole('button', { name: 'Choose a fleet file' }));
      await screen.findByRole('heading', { name: 'Fleet preview' });
      await rememberOption(user, remember);

      confirm.mockReturnValueOnce(false);
      await user.type(screen.getByLabelText('Password'), PASSWORD);
      await user.click(screen.getByRole('button', { name: 'Unlock' }));
      // the question comes first (a red test says so, not a missing message)
      await waitFor(() => {
        expect(confirm.mock.calls).toEqual([[QUESTION('Opening another fleet file')]]);
      });
      expect((await screen.findByRole('alert')).textContent).toBe(KEPT);
      expect(handler.inspect().unlocked).toBeNull(); // nothing reached the worker
      expect(await store.get('account')).toMatchObject({ fileText: newest, unsaved: true });

      // Yes: the file opens and the worker does what the option says.
      confirm.mockReturnValueOnce(true);
      await user.type(screen.getByLabelText('Password'), PASSWORD);
      await user.click(screen.getByRole('button', { name: 'Unlock' }));
      await findFleet();
      expect(confirm).toHaveBeenCalledTimes(2);
      if (remember) {
        expect(await store.get('account')).toMatchObject({ fileText, unsaved: false });
      } else {
        expect(store.keys()).toEqual(['prefs']);
      }
    },
  );

  it.each([true, false])(
    'creating a new fleet (remember %s) asks; No keeps the record and the form',
    async (remember) => {
      const store = memoryRememberStore();
      const { handler, user, confirm, newest } = await lockedWithChanges(store);
      await user.click(screen.getByRole('button', { name: 'Create a new fleet' }));
      await user.clear(screen.getByLabelText('Number of wallets'));
      await user.type(screen.getByLabelText('Number of wallets'), '2');
      await user.type(screen.getByLabelText('Fleet name'), NEW_FLEET);
      await user.type(screen.getByLabelText('Password'), PASSWORD);
      await user.type(screen.getByLabelText('Repeat the password'), PASSWORD);
      await rememberOption(user, remember);

      confirm.mockReturnValueOnce(false);
      await user.click(screen.getByRole('button', { name: 'Create the fleet' }));
      // the question comes first (a red test says so, not a missing message)
      await waitFor(() => {
        expect(confirm.mock.calls).toEqual([[QUESTION('Creating a new fleet')]]);
      });
      expect((await screen.findByRole('alert')).textContent).toBe(KEPT);
      expect(handler.inspect().unlocked).toBeNull();
      expect(await store.get('account')).toMatchObject({ fileText: newest, unsaved: true });
      expect(screen.getByLabelText<HTMLInputElement>('Repeat the password').value).toBe(PASSWORD);

      confirm.mockReturnValueOnce(true);
      await user.click(screen.getByRole('button', { name: 'Create the fleet' }));
      await waitFor(() => {
        expect(handler.inspect().unlocked?.fleetName).toBe(NEW_FLEET);
      });
      expect(confirm).toHaveBeenCalledTimes(2);
      await waitFor(async () => {
        if (remember) {
          // the new fleet is remembered now, with its own file not on disk yet
          const account = await store.get('account');
          expect(account?.fileText).toContain(`"${NEW_FLEET}"`);
          expect(account?.unsaved).toBe(true);
        } else {
          expect(store.keys()).toEqual(['prefs']);
        }
      });
    },
  );

  it('the device cannot be read: opening a file asks without a name; No sends no unlock', async () => {
    const handler = createVaultHandler({ remember: memoryRememberStore() });
    const sent: string[] = [];
    // Every `remembered` question to the worker fails; the rest goes to the real handler.
    const failing = {
      request: (request, options) => {
        sent.push(request.type);
        return request.type === 'remembered'
          ? Promise.reject(new Error('IndexedDB is gone'))
          : handler.handle(request, options);
      },
      onEvent: (l) => handler.onEvent(l),
    } as VaultClient;
    const storage = mockStorage();
    storage.offerFile({ name: FILE_NAME, text: fileText });
    render(<App vault={failing} storage={storage.env} statusPollMs={60_000} />);
    const user = setupUser();
    await user.click(await screen.findByRole('button', { name: 'Open a fleet file' }));
    await user.click(screen.getByRole('button', { name: 'Choose a fleet file' }));
    await screen.findByRole('heading', { name: 'Fleet preview' });

    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    await user.type(screen.getByLabelText('Password'), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Unlock' }));
    // unknown is the risky case: the question comes, with no fleet to name
    await waitFor(() => {
      expect(confirm.mock.calls).toEqual([
        [
          'A fleet is remembered on this device. The fleet file on your disk is older than this fleet, or was never saved: only this browser holds the latest changes. Opening another fleet file replaces it and deletes them for good. Continue anyway?',
        ],
      ]);
    });
    expect((await screen.findByRole('alert')).textContent).toBe(KEPT);
    expect(sent).not.toContain('unlock');
    expect(handler.inspect().unlocked).toBeNull();
  });

  it('a remembered fleet whose file is saved: opening another file asks nothing', async () => {
    const store = memoryRememberStore();
    const { user } = load(store);
    await openFile(user); // opened from disk: nothing only in the browser
    await user.click(screen.getByRole('button', { name: 'Lock' }));
    await screen.findByRole('heading', { name: 'Welcome back' });
    expect((await store.get('account'))?.unsaved).toBe(false);
    const confirm = vi.spyOn(window, 'confirm');
    await user.click(screen.getByRole('button', { name: 'Open another fleet file' }));
    await user.click(screen.getByRole('button', { name: 'Choose a fleet file' }));
    await screen.findByRole('heading', { name: 'Fleet preview' });
    await rememberOption(user, true);
    await user.type(screen.getByLabelText('Password'), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Unlock' }));
    await findFleet();
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe('a browser that keeps no data', () => {
  it('the option is off and disabled with the reason; the fleet still opens', async () => {
    const { user } = load(failingRememberStore());
    await user.click(await screen.findByRole('button', { name: 'Open a fleet file' }));
    await user.click(screen.getByRole('button', { name: 'Choose a fleet file' }));
    await screen.findByRole('heading', { name: 'Fleet preview' });
    await screen.findByText(/does not let the page keep data/u);
    const option = screen.getByRole<HTMLInputElement>('checkbox', {
      name: 'Remember this fleet on this device',
    });
    expect(option.disabled).toBe(true);
    expect(option.checked).toBe(false);
    await user.type(screen.getByLabelText('Password'), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Unlock' }));
    await findFleet();
  });
});
