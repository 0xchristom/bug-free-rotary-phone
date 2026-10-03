// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/core/errors.ts';
import { App } from '../../src/ui/App.tsx';
import { LOCKED, mockStorage, mockVault, unlocked } from './fakes.ts';

const REFRESH_MS = 12_000;
let visibility: DocumentVisibilityState = 'visible';

function setVisibility(state: DocumentVisibilityState): void {
  visibility = state;
  document.dispatchEvent(new Event('visibilitychange'));
}

function renderFleet(vault = mockVault(unlocked())) {
  render(
    <App
      vault={vault.client}
      storage={mockStorage().env}
      statusPollMs={5_000}
      balanceRefreshMs={REFRESH_MS}
    />,
  );
  return vault;
}

async function tick(ms: number): Promise<void> {
  await act(() => vi.advanceTimersByTimeAsync(ms));
}

beforeEach(() => {
  vi.useFakeTimers();
  visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('SOL balance refresh on the fleet screen', () => {
  it('reads at once, then every interval; shows lamports as SOL', async () => {
    const vault = renderFleet();
    await tick(0);
    expect(vault.calls('refreshBalances')).toBe(1);
    expect(screen.getByText('1,5')).toBeTruthy();
    expect(screen.getByText('1,500000002')).toBeTruthy();
    await tick(REFRESH_MS - 1);
    expect(vault.calls('refreshBalances')).toBe(1);
    await tick(1);
    expect(vault.calls('refreshBalances')).toBe(2);
    await tick(REFRESH_MS * 3);
    expect(vault.calls('refreshBalances')).toBe(5);
    // refreshing is not user activity
    expect(vault.calls('activity')).toBe(0);
  });

  it('stops while the tab is hidden and refreshes as soon as it is visible again', async () => {
    const vault = renderFleet();
    await tick(0);
    expect(vault.calls('refreshBalances')).toBe(1);
    act(() => {
      setVisibility('hidden');
    });
    await tick(REFRESH_MS * 10);
    expect(vault.calls('refreshBalances')).toBe(1);
    act(() => {
      setVisibility('visible');
    });
    await tick(0);
    expect(vault.calls('refreshBalances')).toBe(2);
  });

  it('stops when the fleet is locked (auto-lock seen by the status poll)', async () => {
    const vault = renderFleet();
    await tick(0);
    vault.setStatus(LOCKED);
    await tick(5_000);
    expect(screen.getByRole('heading', { name: 'Witaj w Bunndly' })).toBeTruthy();
    const before = vault.calls('refreshBalances');
    await tick(REFRESH_MS * 10);
    expect(vault.calls('refreshBalances')).toBe(before);
  });

  it('"Odśwież salda" reads on demand', async () => {
    const vault = renderFleet();
    await tick(0);
    fireEvent.click(screen.getByRole('button', { name: 'Odśwież salda' }));
    await tick(0);
    expect(vault.calls('refreshBalances')).toBe(2);
  });

  it('shows the fallback and errors in Polish', async () => {
    const vault = mockVault(unlocked());
    vault.request.mockImplementation((req) =>
      req.type === 'refreshBalances'
        ? Promise.resolve({
            balances: [],
            source: 'fallback',
            fetchedAt: '2026-10-02T12:00:00.000Z',
          })
        : Promise.resolve(unlocked()),
    );
    renderFleet(vault);
    await tick(0);
    expect(screen.getByText(/Helius nie odpowiada/u)).toBeTruthy();

    vault.request.mockImplementation((req) =>
      req.type === 'refreshBalances'
        ? Promise.reject(new AppError('HELIUS_KEY_MISSING'))
        : Promise.resolve(unlocked()),
    );
    await tick(REFRESH_MS);
    expect(screen.getByRole('alert').textContent).toBe(
      'Brak klucza API Helius. Dodaj go w Ustawieniach: jest potrzebny do sald, zakupu na żywo i obserwacji twórcy.',
    );
  });
});
