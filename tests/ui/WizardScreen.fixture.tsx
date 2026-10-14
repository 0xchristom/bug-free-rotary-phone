/** Shared setup of the WizardScreen tests, split into several files (BUNNDLY-75). */
import { cleanup, render, screen } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { afterEach, expect, vi } from 'vitest';
import { App } from '../../src/ui/App.tsx';
import type { VaultRequest } from '../../src/worker/protocol.ts';
import type { VaultRequestOptions } from '../../src/worker/vault-client.ts';
import { LOCKED, fleetInfo, mockStorage, mockVault } from './fakes.ts';

export const PASSWORD = 'zielony Kot, 7 krzeseł; drabina';
export const MNEMONIC_12 = `${'abandon '.repeat(11)}about`;

export type CreateRequest = Extract<VaultRequest, { type: 'create' }>;

/** A gate the test opens with `resolve()`. */
export function createGate() {
  let resolve!: () => void;
  const promise = new Promise<undefined>((res) => {
    resolve = () => {
      res(undefined);
    };
  });
  return { promise, resolve };
}

/** Vault whose `create` waits until the test resolves it, reporting 30% progress first. */
export function vaultWithPendingCreate() {
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

export function renderWizard(vault: ReturnType<typeof mockVault>, storage = mockStorage()) {
  render(<App vault={vault.client} storage={storage.env} statusPollMs={60_000} />);
  return storage;
}

export async function openWizard(user: UserEvent): Promise<void> {
  await user.click(await screen.findByRole('button', { name: 'Create a new fleet' }));
}

export function field(label: string | RegExp): HTMLInputElement {
  return screen.getByLabelText(label);
}

export async function fillValidForm(user: UserEvent, password = PASSWORD): Promise<void> {
  await user.clear(field('Number of wallets'));
  await user.type(field('Number of wallets'), '30');
  await user.type(field('Fleet name'), 'Flota testowa');
  await user.type(field('Password'), password);
  await user.type(field('Repeat the password'), password);
}

/**
 * Whether the browser would ask before closing the tab. From the outside this is what tells
 * that the app holds a fleet file that is not saved yet.
 *
 * The wizard reports "unsaved" to the app in an effect, one render after the heading
 * changes, and the keyboard and mouse of `setupUser()` do not wait for it. A test whose next
 * click depends on that report waits for this state first.
 */
export function closingTabAsks(): boolean {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

export function createButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: 'Create the fleet' });
}

export function createRequests(vault: ReturnType<typeof mockVault>): CreateRequest[] {
  return vault.request.mock.calls
    .map(([request]) => request)
    .filter((request): request is CreateRequest => request.type === 'create');
}

/** Texts of the messages shown next to the fields, in screen order. */
export function fieldErrors(): string[] {
  return Array.from(document.querySelectorAll('.field-error'), (el) => el.textContent);
}

/** Clicks "Create the fleet" and checks that nothing was sent and the form is still there. */
export async function clickAndExpectNoFleet(
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
