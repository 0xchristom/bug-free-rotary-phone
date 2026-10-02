// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/core/errors.ts';
import { App } from '../../src/ui/App.tsx';
import type { VaultRequest, VaultStatus } from '../../src/worker/protocol.ts';
import type { VaultClient } from '../../src/worker/vault-client.ts';

const LOCKED: VaultStatus = { locked: true, armed: false, info: null };

function unlocked(armed = false): VaultStatus {
  return {
    locked: false,
    armed,
    info: {
      fleetName: 'Flota testowa',
      createdAt: '2026-10-02T00:00:00.000Z',
      wallets: [0, 1, 2].map((index) => ({
        index,
        address: `Address${String(index)}`,
        derivationPath: `m/44'/501'/${String(index)}'/0'`,
        label: `W0${String(index + 1)}`,
      })),
      settings: { maxSpend: [] },
      apiKeys: {},
    },
  };
}

/** Fake vault worker client; `status` can be changed to simulate auto-lock. */
function mockVault(initial: VaultStatus) {
  let status = initial;
  const request = vi.fn((req: VaultRequest): Promise<unknown> => {
    switch (req.type) {
      case 'status':
      case 'activity':
        return Promise.resolve(status);
      case 'lock':
        status = LOCKED;
        return Promise.resolve(status);
      default:
        return Promise.reject(new AppError('INTERNAL_ERROR'));
    }
  });
  return {
    client: { request } as unknown as VaultClient,
    request,
    setStatus: (next: VaultStatus) => {
      status = next;
    },
    calls: (type: VaultRequest['type']) =>
      request.mock.calls.filter(([r]) => r.type === type).length,
  };
}

function renderApp(
  vault: ReturnType<typeof mockVault>,
  statusPollMs = 20,
  activityThrottleMs = 10_000,
) {
  return render(
    <App
      vault={vault.client}
      statusPollMs={statusPollMs}
      activityThrottleMs={activityThrottleMs}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('navigation', () => {
  it('locked vault: start screen, wizard and back; no fleet navigation or lock button', async () => {
    const user = userEvent.setup();
    renderApp(mockVault(LOCKED));
    expect(await screen.findByRole('heading', { name: 'Witaj w Bunndly' })).toBeTruthy();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Zablokuj' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Utwórz nową flotę' }));
    expect(screen.getByRole('heading', { name: 'Kreator nowej floty' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Wróć' }));
    expect(screen.getByRole('heading', { name: 'Witaj w Bunndly' })).toBeTruthy();
  });

  it('unlocked vault: fleet screen with the fleet name; switches to settings and back', async () => {
    const user = userEvent.setup();
    renderApp(mockVault(unlocked()));
    expect(await screen.findByRole('heading', { name: 'Flota' })).toBeTruthy();
    expect(screen.getByText('Flota testowa')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();

    const nav = screen.getByRole('navigation', { name: 'Nawigacja' });
    await user.click(within(nav).getByRole('button', { name: 'Ustawienia' }));
    expect(screen.getByRole('heading', { name: 'Ustawienia' })).toBeTruthy();
    expect(
      within(nav).getByRole('button', { name: 'Ustawienia' }).getAttribute('aria-current'),
    ).toBe('page');

    await user.click(within(nav).getByRole('button', { name: 'Flota' }));
    expect(screen.getByRole('heading', { name: 'Flota' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('15 min');
  });

  it('shows that auto-lock is suspended while armed', async () => {
    renderApp(mockVault(unlocked(true)));
    expect((await screen.findByRole('status')).textContent).toContain('wstrzymana');
  });
});

describe('vault status changes', () => {
  it('auto-lock in the worker brings the UI back to the start screen', async () => {
    const vault = mockVault(unlocked());
    renderApp(vault);
    expect(await screen.findByRole('heading', { name: 'Flota' })).toBeTruthy();

    vault.setStatus(LOCKED);
    expect(await screen.findByRole('heading', { name: 'Witaj w Bunndly' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('zablokowana automatycznie');
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByText('Flota testowa')).toBeNull();
  });

  it('“Zablokuj” calls lock and returns to the start screen', async () => {
    const user = userEvent.setup();
    const vault = mockVault(unlocked());
    renderApp(vault, 60_000);
    await user.click(await screen.findByRole('button', { name: 'Zablokuj' }));
    expect(vault.calls('lock')).toBe(1);
    expect(await screen.findByRole('heading', { name: 'Witaj w Bunndly' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toBe('Flota została zablokowana.');
  });

  it('a vault error is shown as a Polish message', async () => {
    const vault = mockVault(LOCKED);
    vault.request.mockImplementation(() => Promise.reject(new AppError('VAULT_TIMEOUT')));
    renderApp(vault, 60_000);
    expect((await screen.findByRole('alert')).textContent).toContain('nie odpowiedział');
  });
});

describe('activity reporting', () => {
  it('reports user activity at most once per throttle window, only when unlocked', async () => {
    const user = userEvent.setup();
    const vault = mockVault(unlocked());
    renderApp(vault, 60_000);
    const nav = await screen.findByRole('navigation');
    await user.click(within(nav).getByRole('button', { name: 'Ustawienia' }));
    await user.click(within(nav).getByRole('button', { name: 'Flota' }));
    await user.keyboard('a');
    expect(vault.calls('activity')).toBe(1);

    cleanup();
    const locked = mockVault(LOCKED);
    renderApp(locked, 60_000);
    await user.click(await screen.findByRole('button', { name: 'Utwórz nową flotę' }));
    expect(locked.calls('activity')).toBe(0);
  });
});

describe('nothing in storage or the URL (SPEC 6.1)', () => {
  it('a full session writes nothing to localStorage, sessionStorage, cookies or the URL', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const pushState = vi.spyOn(window.history, 'pushState');
    const replaceState = vi.spyOn(window.history, 'replaceState');
    const href = window.location.href;
    const user = userEvent.setup();
    const vault = mockVault(unlocked());
    renderApp(vault);

    const nav = await screen.findByRole('navigation');
    await user.click(within(nav).getByRole('button', { name: 'Ustawienia' }));
    await user.click(within(nav).getByRole('button', { name: 'Flota' }));
    await user.click(screen.getByRole('button', { name: 'Zablokuj' }));
    await user.click(await screen.findByRole('button', { name: 'Utwórz nową flotę' }));
    await user.click(screen.getByRole('button', { name: 'Wróć' }));
    await waitFor(() => {
      expect(vault.calls('status')).toBeGreaterThan(1);
    });

    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).toBe('');
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
    expect(window.location.href).toBe(href);
  });
});
