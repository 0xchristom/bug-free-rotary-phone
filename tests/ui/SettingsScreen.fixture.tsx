/** Shared setup of the SettingsScreen tests, split into several files (BUNNDLY-75). */
import { cleanup, render, screen, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { afterEach, vi } from 'vitest';
import { App } from '../../src/ui/App.tsx';
import { createVaultHandler, type VaultHandler } from '../../src/worker/vault.ts';
import type { VaultClient } from '../../src/worker/vault-client.ts';
import { mockStorage } from './fakes.ts';
import { setupUser } from './user.ts';

// The key derivation is not the subject here: the fast stand-in keeps the key bound to
// the password, the salt and the cost (tests/helpers/fast-kdf.ts, BUNNDLY-74).

export const PASSWORD = 'zielony Kot, 7 krzeseł; drabina';
export const HELIUS_KEY = 'heliusKeyUiTest123';
export const JUPITER_KEY = 'jupiterKeyUiTest456';
export const FILE_NAME = 'Ustawienia.keystore.json';

vi.setConfig({ testTimeout: 60_000 });

export async function setup() {
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
    onEvent: (l) => handler.onEvent(l),
  } as VaultClient;
  const storage = mockStorage();
  render(<App vault={client} storage={storage.env} statusPollMs={60_000} />);
  const user = setupUser();
  const nav = await screen.findByRole('navigation', {}, { timeout: 10_000 });
  await user.click(within(nav).getByRole('button', { name: 'Settings' }));
  await screen.findByRole('heading', { name: 'Settings' });
  return { handler, storage, user, requests };
}

export function field(label: string | RegExp): HTMLInputElement {
  return screen.getByLabelText(label);
}

export async function retype(user: UserEvent, label: string | RegExp, text: string): Promise<void> {
  await user.clear(field(label));
  if (text !== '') await user.type(field(label), text);
}

export function saveButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Save settings' });
}

export async function saveSettings(user: UserEvent): Promise<void> {
  await user.click(saveButton());
  await screen.findByRole('button', { name: 'Save the updated fleet file' });
}

export function keysIn(handler: VaultHandler): unknown {
  return handler.inspect().unlocked?.apiKeys;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
