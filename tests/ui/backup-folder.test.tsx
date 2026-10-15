// @vitest-environment jsdom
/**
 * The backup folder on screen (BUNNDLY-62) against the real vault handler: the dialog
 * with its warning and password, the rail's state, the click that reconnects the folder
 * and the "Not backed up" mark. The folder is in memory (tests/helpers/backup-folder.ts).
 */
import { base58 } from '@scure/base';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PLAIN_BACKUP_SUFFIX } from '../../src/worker/backup.ts';
import { App } from '../../src/ui/App.tsx';
import { createVaultHandler, type VaultHandler } from '../../src/worker/vault.ts';
import type { VaultClient } from '../../src/worker/vault-client.ts';
import {
  memoryBackupStore,
  memoryFolder,
  type MemoryBackupStore,
  type MemoryFolder,
} from '../helpers/backup-folder.ts';
import { LOCKED, mockStorage, mockVault, unlocked } from './fakes.ts';
import { setupUser } from './user.ts';

vi.mock('@noble/hashes/scrypt.js', () => import('../helpers/fast-kdf.ts'));

vi.setConfig({ testTimeout: 60_000 });
const WAIT = { timeout: 20_000 };

const PASSWORD = 'zielony Kot, 7 krzeseł; drabina';
const MNEMONIC = `${'abandon '.repeat(11)}about`;
const CONFIRM =
  'I understand that the plain-text file in this folder gives full access to the funds';
const PASSWORD_LABEL = 'Fleet password (type it again)';
const TURN_ON = 'Choose the folder and turn on';
/** 01:02:03 on this machine's clock, whatever its time zone: what the rail must show. */
const AT = new Date(2026, 9, 15, 1, 2, 3).getTime();

function clientOf(handler: VaultHandler): VaultClient {
  return {
    request: (request: unknown, options?: object) => handler.handle(request, options),
    onEvent: (l) => handler.onEvent(l),
  } as VaultClient;
}

function railText(): string {
  return screen.getByRole('contentinfo', { name: 'Status' }).textContent;
}

function secretsOf(h: VaultHandler): string[] {
  const v = h.inspect().unlocked;
  if (!v) return [];
  return [
    new TextDecoder().decode(v.mnemonic),
    ...v.wallets.flatMap((w) => [
      base58.encode(w.secretKey),
      base58.encode(w.secretKey.slice(0, 32)),
    ]),
  ];
}

interface Screen {
  readonly handler: VaultHandler;
  readonly folder: MemoryFolder;
  readonly store: MemoryBackupStore;
  readonly picker: ReturnType<typeof vi.fn>;
}

async function fleetScreen(
  folder = memoryFolder(),
  store = memoryBackupStore(),
  open?: (h: VaultHandler) => Promise<void>,
  statusPollMs = 60_000,
): Promise<Screen> {
  const handler = createVaultHandler({ now: () => AT, backup: store });
  if (open) {
    await open(handler);
  } else {
    await handler.handle({
      type: 'create',
      fleetName: 'Kopia',
      walletCount: 2,
      password: PASSWORD,
      mnemonic: MNEMONIC,
    });
  }
  const storage = mockStorage();
  const picker = vi.fn(() => Promise.resolve(folder));
  render(
    <App
      vault={clientOf(handler)}
      storage={{ ...storage.env, showDirectoryPicker: picker }}
      statusPollMs={statusPollMs}
      balanceRefreshMs={60_000}
    />,
  );
  await screen.findByRole('heading', { name: 'Fleet' }, WAIT);
  return { handler, folder, store, picker };
}

async function turnOn(password: string): Promise<HTMLElement> {
  const user = setupUser();
  await user.click(await screen.findByRole('button', { name: 'Set up folder' }, WAIT));
  const dialog = screen.getByRole('dialog');
  const button = within(dialog).getByRole('button', { name: TURN_ON });
  await user.type(within(dialog).getByLabelText(PASSWORD_LABEL), password);
  expect(button).toHaveProperty('disabled', true); // the warning is not confirmed yet
  await user.click(within(dialog).getByLabelText(CONFIRM));
  await user.click(button);
  return dialog;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('the backup folder on screen', () => {
  it('turned on: both files written, the rail says saved with the unencrypted keys, nothing secret on the page', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m),
    );
    const s = await fleetScreen();
    expect(railText()).toContain('Backup: off');
    const dialog = await turnOn(PASSWORD);
    await within(dialog).findByText(/Backup saved to the folder “Bunndly backups”/u, {}, WAIT);
    expect(within(dialog).getByRole('heading').textContent).toBe('Backup folder');
    expect(dialog.textContent).toContain('Do not choose a folder synced to the cloud');
    expect(s.picker).toHaveBeenCalledTimes(1);
    expect(s.folder.writes.map((w) => w.name)).toEqual([
      'Kopia.keystore.json',
      `Kopia${PLAIN_BACKUP_SUFFIX}`,
    ]);
    await waitFor(() => {
      expect(railText()).toContain('Backup: saved 01:02:03 · unencrypted keys');
    });
    // The phrase went to the folder and nowhere on the page, in storage or in the console.
    expect(s.folder.files.get(`Kopia${PLAIN_BACKUP_SUFFIX}`)).toContain(MNEMONIC);
    const page = document.body.innerHTML;
    const secrets = secretsOf(s.handler);
    expect(secrets.length).toBe(5);
    for (const secret of secrets) expect(page).not.toContain(secret);
    expect(page).not.toContain('abandon');
    expect(page).not.toContain(PASSWORD);
    expect(setItem).not.toHaveBeenCalled();
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });

  it('a wrong password: the folder stays off and nothing is written', async () => {
    const s = await fleetScreen();
    const dialog = await turnOn(`${PASSWORD}x`);
    expect((await within(dialog).findByRole('alert', {}, WAIT)).textContent).toContain(
      'The password is wrong',
    );
    expect(s.folder.writes).toEqual([]);
    expect(s.store.dump()).toBeNull();
    expect(railText()).toContain('Backup: off');
  });

  it('a failed write: the rail says failed and the new wallet is marked Not backed up', async () => {
    // The wallet is added beside the screen: the status poll brings its row.
    const s = await fleetScreen(undefined, undefined, undefined, 100);
    await turnOn(PASSWORD);
    await waitFor(() => {
      expect(railText()).toContain('Backup: saved');
    }, WAIT);
    expect(screen.queryByText('Not backed up')).toBeNull();
    s.folder.failWrites = true;
    await s.handler.handle({ type: 'addWallets', count: 1 });
    await waitFor(() => {
      expect(railText()).toContain('Backup: failed');
    }, WAIT);
    const chips = await screen.findAllByText('Not backed up', {}, WAIT);
    expect(chips).toHaveLength(1);
    // The chip is in the new wallet's row (index 2), not in the others.
    const row = chips[0]?.closest('tr');
    expect(row?.querySelector('.w-name')?.textContent).toBe('Wallet 2');
  });

  it('after a reload with access at prompt: Reconnect, no write before the click, then saved', async () => {
    const folder = memoryFolder();
    const store = memoryBackupStore();
    // The first visit: the folder on, its file on disk.
    const first = createVaultHandler({ now: () => AT, backup: store });
    await first.handle({
      type: 'create',
      fleetName: 'Kopia',
      walletCount: 2,
      password: PASSWORD,
      mnemonic: MNEMONIC,
    });
    await first.handle({ type: 'enableBackup', handle: folder, password: PASSWORD });
    const fileText = folder.files.get('Kopia.keystore.json') ?? '';
    const writes = folder.writes.length;
    // The reload: the browser asks again.
    folder.permission = 'prompt';
    await fleetScreen(folder, store, async (h) => {
      await h.handle({ type: 'unlock', fileText, password: PASSWORD });
    });
    const reconnect = await screen.findByRole('button', { name: 'Backup: reconnect' }, WAIT);
    expect(folder.writes.length).toBe(writes);
    expect(folder.asked.requested).toBe(0);
    await setupUser().click(reconnect);
    await waitFor(() => {
      expect(railText()).toContain('Backup: saved 01:02:03');
    }, WAIT);
    expect(folder.asked.requested).toBe(1);
    expect(folder.writes.length).toBe(writes + 2);
  });
});

describe('the rail without the real worker', () => {
  const saved = (plain: boolean) => ({
    state: { kind: 'saved' as const, folder: 'B', at: new Date(AT).toISOString() },
    plain,
    notBackedUp: [],
  });

  it('a browser without folder access says manual download, never saved', async () => {
    const vault = mockVault(unlocked());
    const storage = mockStorage('download');
    render(<App vault={vault.client} storage={storage.env} statusPollMs={60_000} />);
    await waitFor(() => {
      expect(railText()).toContain('Backup: manual download');
    });
    act(() => {
      vault.emit({ kind: 'backup', view: saved(true) });
    });
    expect(railText()).toContain('Backup: manual download');
    expect(railText()).not.toContain('saved');
    expect(screen.queryByRole('button', { name: 'Set up folder' })).toBeNull();
    for (const [, name] of storage.clickDownload.mock.calls) {
      expect(String(name)).not.toContain('PLAIN-BACKUP');
    }
  });

  it('with the plain file switched off the rail does not say unencrypted keys', async () => {
    const vault = mockVault(unlocked());
    render(<App vault={vault.client} storage={mockStorage().env} statusPollMs={60_000} />);
    await waitFor(() => {
      expect(railText()).toContain('Backup: off');
    });
    vault.emit({ kind: 'backup', view: saved(false) });
    await waitFor(() => {
      expect(railText()).toContain('Backup: saved 01:02:03');
    });
    expect(railText()).not.toContain('unencrypted');
    vault.emit({ kind: 'backup', view: saved(true) });
    await waitFor(() => {
      expect(railText()).toContain('Backup: saved 01:02:03 · unencrypted keys');
    });
  });

  it('locked: no backup state at all', async () => {
    const vault = mockVault(LOCKED);
    render(<App vault={vault.client} storage={mockStorage().env} statusPollMs={60_000} />);
    await screen.findByRole('contentinfo', { name: 'Status' });
    expect(railText()).not.toContain('Backup');
  });
});
