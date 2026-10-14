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
    expect(screen.getByText('1.5')).toBeTruthy();
    expect(screen.getByText('1.500000002')).toBeTruthy();
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
    expect(screen.getByRole('heading', { name: 'Welcome to Bunndly' })).toBeTruthy();
    const before = vault.calls('refreshBalances');
    await tick(REFRESH_MS * 10);
    expect(vault.calls('refreshBalances')).toBe(before);
  });

  it('the fleet-balance chip in the top bar reads on demand', async () => {
    const vault = renderFleet();
    await tick(0);
    fireEvent.click(screen.getByRole('button', { name: /^Fleet balance:/u }));
    await tick(0);
    expect(vault.calls('refreshBalances')).toBe(2);
  });

  it('the fleet-balance chip shows the sum of all wallets, counted by hand', async () => {
    renderFleet();
    await tick(0);
    // The fake fleet: wallets 0, 1, 2 with 1.5 SOL + index lamports each.
    // 1_500_000_000 + 1_500_000_001 + 1_500_000_002 = 4_500_000_003 lamports = 4.500000003 SOL.
    expect(screen.getByTestId('fleet-balance').textContent).toBe('4.500000003');
    expect(
      screen.getByRole('button', { name: /^Fleet balance:/u }).getAttribute('aria-label'),
    ).toBe('Fleet balance: 4.500000003 SOL. Read again');
  });

  it('the fleet-balance chip shows "—" before the first read', async () => {
    const vault = mockVault(unlocked());
    vault.request.mockImplementation((req) =>
      req.type === 'refreshBalances' ? new Promise(() => undefined) : Promise.resolve(unlocked()),
    );
    renderFleet(vault);
    await tick(0);
    expect(screen.getByTestId('fleet-balance').textContent).toBe('—');
    expect(
      screen.getByRole('button', { name: /^Fleet balance:/u }).getAttribute('aria-label'),
    ).toBe('Fleet balance: not read yet. Read again');
  });

  it('shows the fallback and errors in English', async () => {
    const vault = mockVault(unlocked());
    vault.request.mockImplementation((req) =>
      req.type === 'refreshBalances'
        ? Promise.resolve({
            balances: [],
            network: 'mainnet',
            source: 'fallback',
            fetchedAt: '2026-10-02T12:00:00.000Z',
          })
        : Promise.resolve(unlocked()),
    );
    renderFleet(vault);
    await tick(0);
    expect(screen.getByText(/Helius is not responding/u)).toBeTruthy();

    vault.request.mockImplementation((req) =>
      req.type === 'refreshBalances'
        ? Promise.reject(new AppError('HELIUS_KEY_MISSING'))
        : Promise.resolve(unlocked()),
    );
    await tick(REFRESH_MS);
    expect(screen.getByRole('alert').textContent).toBe(
      'The Helius API key is missing. Add it in Settings: balances, live buys and the watcher need it.',
    );
  });
});
