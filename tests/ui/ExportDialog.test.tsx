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
    onEvent: (l) => handler.onEvent(l),
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
    await screen.findByRole(
      'button',
      { name: 'Plain export (recovery phrase and keys)' },
      SCRYPT_WAIT,
    ),
  );
  return { user, storage, blobs, timers, dialog: screen.getByRole('dialog') };
}

function exportButton(dialog: HTMLElement): HTMLButtonElement {
  return within(dialog).getByRole('button', { name: 'Download the plain export' });
}

async function typePassword(user: UserEvent, dialog: HTMLElement, pw: string): Promise<void> {
  await user.type(within(dialog).getByLabelText('Fleet password (type it again)'), pw);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('plain export dialog', () => {
  it('the export button stays disabled without the confirmation (and without a password)', async () => {
    const { user, dialog } = await fleetScreen();
    expect(within(dialog).getByRole('heading').textContent).toContain('Plain export');
    // inline dialog, the rest of the page stays usable: not announced as modal
    expect(dialog.hasAttribute('aria-modal')).toBe(false);
    expect(exportButton(dialog).disabled).toBe(true);
    await typePassword(user, dialog, PASSWORD);
    expect(exportButton(dialog).disabled).toBe(true); // password alone is not enough
    await user.click(
      within(dialog).getByLabelText('I understand that this file gives full access to the funds'),
    );
    expect(exportButton(dialog).disabled).toBe(false);
    await user.clear(within(dialog).getByLabelText('Fleet password (type it again)'));
    expect(exportButton(dialog).disabled).toBe(true); // confirmation alone is not enough
  });

  it('a wrong password: English message, field cleared, nothing downloaded', async () => {
    const { user, dialog, storage } = await fleetScreen();
    await user.click(
      within(dialog).getByLabelText('I understand that this file gives full access to the funds'),
    );
    await typePassword(user, dialog, `${PASSWORD}x`);
    await user.click(exportButton(dialog));
    expect((await within(dialog).findByRole('alert', {}, SCRYPT_WAIT)).textContent).toContain(
      'The password is wrong',
    );
    expect(
      within(dialog).getByLabelText<HTMLInputElement>('Fleet password (type it again)').value,
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
      within(dialog).getByLabelText('I understand that this file gives full access to the funds'),
    );
    await user.click(within(dialog).getByLabelText('JSON (.json)'));
    await typePassword(user, dialog, PASSWORD);
    await user.click(exportButton(dialog));
    await within(dialog).findByText(/Downloaded Kopia\.PLAIN-EXPORT\.json/u, {}, SCRYPT_WAIT);

    expect(storage.clickDownload).toHaveBeenCalledWith('blob:export', 'Kopia.PLAIN-EXPORT.json');
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
  it('"Back up the recovery phrase" on the final screen opens the same dialog', async () => {
    const handler = createVaultHandler();
    const storage = mockStorage();
    render(<App vault={clientOf(handler)} storage={storage.env} statusPollMs={60_000} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Create a new fleet' }));
    await user.type(screen.getByLabelText('Fleet name'), 'Nowa');
    await user.type(screen.getByLabelText('Password'), PASSWORD);
    await user.type(screen.getByLabelText('Repeat the password'), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Create the fleet' }));
    await user.click(
      await screen.findByRole('button', { name: 'Save the fleet file' }, SCRYPT_WAIT),
    );
    await user.click(await screen.findByRole('button', { name: 'Back up the recovery phrase' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('heading').textContent).toContain('Plain export');
    expect(exportButton(dialog).disabled).toBe(true);
    // the wizard itself never shows the mnemonic
    const vault = handler.inspect().unlocked;
    if (!vault) throw new Error('not unlocked');
    const words = new TextDecoder().decode(vault.mnemonic).split(' ');
    expect(words).toHaveLength(24);
    const page = pageWords();
    // The page was really read: these words of the final screen are in it.
    expect(page).toEqual(expect.arrayContaining(['plain', 'export', 'fleet', 'password']));
    // The interface is English, so single BIP39 words ("cloud", "wallet", "file") are on
    // the page anyway. Three words in the mnemonic's order are not, however the page lays
    // them out: one per list item, numbered, one per line or in a field.
    const text = ` ${page.join(' ')} `;
    const triples = words
      .slice(0, -2)
      .map((w, i) => ` ${w} ${String(words[i + 1])} ${String(words[i + 2])} `);
    expect(triples).toHaveLength(22);
    expect(triples.filter((t) => text.includes(t))).toEqual([]);
    // A shuffled mnemonic has no such triple, so the words are counted too. This screen
    // holds 24 BIP39 words (measured, BUNNDLY-50), so a random mnemonic shares more than
    // MAX_SHARED_WORDS with it about 3 times in 10^7 runs.
    const onPage = new Set(page);
    const shared = [...new Set(words)].filter((w) => onPage.has(w));
    expect(shared.length).toBeLessThanOrEqual(MAX_SHARED_WORDS);
  });
});

const MAX_SHARED_WORDS = 5;

/**
 * The words of the page as a person meets them: every text node, the value of every field
 * and the attributes that are shown or read out. Anything that is not a letter separates
 * words, so list numbers, line breaks and punctuation between two words do not hide them.
 */
function pageWords(): string[] {
  const parts: string[] = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) parts.push(walker.currentNode.textContent ?? '');
  for (const el of document.body.querySelectorAll('*')) {
    if (
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement
    ) {
      parts.push(el.value);
    }
    for (const name of ['value', 'title', 'aria-label', 'placeholder', 'alt']) {
      parts.push(el.getAttribute(name) ?? '');
    }
  }
  return parts
    .join(' ')
    .toLowerCase()
    .split(/[^a-z]+/u)
    .filter((word) => word !== '');
}
