// @vitest-environment jsdom
/** Plain export dialog (BUNNDLY-11) against the real vault handler. */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/ui/App.tsx';
import { createVaultHandler } from '../../src/worker/vault.ts';
import type { VaultClient } from '../../src/worker/vault-client.ts';
import { mockStorage } from './fakes.ts';

const PASSWORD = 'zielony Kot, 7 krzeseł; drabina';
const MNEMONIC = `${'abandon '.repeat(11)}about`;

vi.setConfig({ testTimeout: 60_000 });
const SCRYPT_WAIT = { timeout: 20_000 };

function clientOf(handler: ReturnType<typeof createVaultHandler>): VaultClient {
  return {
    request: (request: unknown, options?: object) => handler.handle(request, options),
  } as VaultClient;
}

async function fleetScreen() {
  const handler = createVaultHandler();
  await handler.handle({
    type: 'create',
    fleetName: 'Kopia',
    walletCount: 2,
    password: PASSWORD,
    mnemonic: MNEMONIC,
  });
  const storage = mockStorage();
  const blobs: Blob[] = [];
  (storage.env.createObjectURL as ReturnType<typeof vi.fn>).mockImplementation((b: Blob) => {
    blobs.push(b);
    return 'blob:export';
  });
  const timers: number[] = [];
  const env = {
    ...storage.env,
    setTimeout: (_cb: () => void, ms: number) => {
      timers.push(ms);
    },
  };
  render(
    <App vault={clientOf(handler)} storage={env} statusPollMs={60_000} balanceRefreshMs={60_000} />,
  );
  const user = userEvent.setup();
  await user.click(
    await screen.findByRole('button', { name: 'Eksport jawny (mnemonik i klucze)' }, SCRYPT_WAIT),
  );
  return { user, storage, blobs, timers, dialog: screen.getByRole('dialog') };
}

function exportButton(dialog: HTMLElement): HTMLButtonElement {
  return within(dialog).getByRole('button', { name: 'Pobierz eksport jawny' });
}

async function typePassword(user: UserEvent, dialog: HTMLElement, pw: string): Promise<void> {
  await user.type(within(dialog).getByLabelText('Hasło floty (wpisz ponownie)'), pw);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('plain export dialog', () => {
  it('the export button stays disabled without the confirmation (and without a password)', async () => {
    const { user, dialog } = await fleetScreen();
    expect(within(dialog).getByRole('heading').textContent).toContain('Eksport jawny');
    // inline dialog, the rest of the page stays usable: not announced as modal
    expect(dialog.hasAttribute('aria-modal')).toBe(false);
    expect(exportButton(dialog).disabled).toBe(true);
    await typePassword(user, dialog, PASSWORD);
    expect(exportButton(dialog).disabled).toBe(true); // password alone is not enough
    await user.click(
      within(dialog).getByLabelText('Rozumiem, że ten plik daje pełny dostęp do środków'),
    );
    expect(exportButton(dialog).disabled).toBe(false);
    await user.clear(within(dialog).getByLabelText('Hasło floty (wpisz ponownie)'));
    expect(exportButton(dialog).disabled).toBe(true); // confirmation alone is not enough
  });

  it('a wrong password: Polish message, field cleared, nothing downloaded', async () => {
    const { user, dialog, storage } = await fleetScreen();
    await user.click(
      within(dialog).getByLabelText('Rozumiem, że ten plik daje pełny dostęp do środków'),
    );
    await typePassword(user, dialog, `${PASSWORD}x`);
    await user.click(exportButton(dialog));
    expect((await within(dialog).findByRole('alert', {}, SCRYPT_WAIT)).textContent).toContain(
      'Hasło jest błędne',
    );
    expect(
      within(dialog).getByLabelText<HTMLInputElement>('Hasło floty (wpisz ponownie)').value,
    ).toBe('');
    expect(storage.clickDownload).not.toHaveBeenCalled();
  });

  it('the right password downloads the file at once; the content never reaches the page', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      vi.spyOn(console, m),
    );
    const { user, dialog, storage, blobs, timers } = await fleetScreen();
    await user.click(
      within(dialog).getByLabelText('Rozumiem, że ten plik daje pełny dostęp do środków'),
    );
    await user.click(within(dialog).getByLabelText('JSON (.json)'));
    await typePassword(user, dialog, PASSWORD);
    await user.click(exportButton(dialog));
    await within(dialog).findByText(/Pobrano plik Kopia\.EKSPORT-JAWNY\.json/u, {}, SCRYPT_WAIT);

    expect(storage.clickDownload).toHaveBeenCalledWith('blob:export', 'Kopia.EKSPORT-JAWNY.json');
    expect(blobs).toHaveLength(1);
    expect(blobs[0]?.type).toBe('application/json');
    const content = await blobs[0]?.text();
    expect(content).toContain(MNEMONIC);
    // the object URL is released after the download delay
    expect(timers).toEqual([60_000]);
    // nothing secret on the page, in storage or in the console
    expect(document.body.innerHTML).not.toContain('abandon');
    expect(document.body.innerHTML).not.toContain(PASSWORD);
    expect(setItem).not.toHaveBeenCalled();
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });
});

describe('wizard', () => {
  it('"Zrób kopię zapasową mnemonika" on the final screen opens the same dialog', async () => {
    const handler = createVaultHandler();
    const storage = mockStorage();
    render(<App vault={clientOf(handler)} storage={storage.env} statusPollMs={60_000} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Utwórz nową flotę' }));
    await user.type(screen.getByLabelText('Nazwa floty'), 'Nowa');
    await user.type(screen.getByLabelText('Hasło'), PASSWORD);
    await user.type(screen.getByLabelText('Powtórz hasło'), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Utwórz flotę' }));
    await user.click(await screen.findByRole('button', { name: 'Zapisz plik floty' }, SCRYPT_WAIT));
    await user.click(await screen.findByRole('button', { name: 'Zrób kopię zapasową mnemonika' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading').textContent).toContain('Eksport jawny');
    expect(exportButton(dialog).disabled).toBe(true);
    // the wizard itself never shows the mnemonic
    const vault = handler.inspect().unlocked;
    if (!vault) throw new Error('not unlocked');
    const words = new TextDecoder().decode(vault.mnemonic).split(' ');
    expect(words).toHaveLength(24);
    const page = ` ${document.body.textContent.toLowerCase()} `;
    expect(page).not.toContain(words.join(' '));
    expect(words.filter((w) => w.length > 3 && new RegExp(`\\b${w}\\b`, 'u').test(page))).toEqual(
      [],
    );
  });
});
