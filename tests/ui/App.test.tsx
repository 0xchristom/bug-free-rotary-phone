// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/core/errors.ts';
import { App } from '../../src/ui/App.tsx';
import type { VaultPort } from '../../src/worker/protocol.ts';
import { createVaultClient } from '../../src/worker/vault-client.ts';
import { LOCKED, mockStorage, mockVault, unlocked } from './fakes.ts';

function renderApp(
  vault: ReturnType<typeof mockVault>,
  statusPollMs = 20,
  activityThrottleMs = 10_000,
) {
  return render(
    <App
      vault={vault.client}
      storage={mockStorage().env}
      statusPollMs={statusPollMs}
      activityThrottleMs={activityThrottleMs}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
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

  it('auto-lock shows on the start screen within one poll (5 s, fake clock)', async () => {
    vi.useFakeTimers();
    const vault = mockVault(unlocked());
    render(<App vault={vault.client} storage={mockStorage().env} />); // default poll interval
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByRole('heading', { name: 'Flota' })).toBeTruthy();

    vault.setStatus(LOCKED);
    await act(() => vi.advanceTimersByTimeAsync(4_999));
    expect(screen.getByRole('heading', { name: 'Flota' })).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(screen.getByRole('heading', { name: 'Witaj w Bunndly' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('zablokowana automatycznie');
    // the fleet data is gone from the page
    expect(screen.queryByText('Flota testowa')).toBeNull();
  });

  it('a worker failure rejects pending requests at once and shows a Polish message', async () => {
    let fail: (() => void) | undefined;
    const port: VaultPort = {
      postMessage: vi.fn(), // the "worker" never answers
      addEventListener: () => undefined,
      addFailureListener: (listener) => {
        fail = listener;
      },
    };
    render(
      <App vault={createVaultClient(port)} storage={mockStorage().env} statusPollMs={60_000} />,
    );
    expect(screen.getByText('Łączenie z sejfem…')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    act(() => {
      fail?.();
    });
    expect((await screen.findByRole('alert')).textContent).toContain('wewnętrzny błąd');
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
