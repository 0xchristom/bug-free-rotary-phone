// @vitest-environment jsdom
/** Operations log panel on the fleet screen (BUNNDLY-25): counts events, downloads CSV/JSON. */
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WalletEvent } from '../../src/executor/index.ts';
import { App } from '../../src/ui/App.tsx';
import { mockStorage, mockVault, unlocked } from './fakes.ts';

afterEach(cleanup);

const T = Date.UTC(2026, 9, 2, 12, 0, 0);

function walletEvent(index: number, state: WalletEvent['state']): WalletEvent {
  return {
    kind: 'wallet',
    runId: 3,
    at: T,
    index,
    state,
    attempt: 1,
    reason: null,
    quote: { inAmount: 10_000_000n, outAmount: 2_101n, router: '=1+1' },
    result:
      state === 'CONFIRMED'
        ? { signature: 'Sig1', slot: 9n, totalInputAmount: 10_000_000n, totalOutputAmount: 2_101n }
        : null,
    times: { orderMs: 120, signMs: 3, executeMs: 900, sinceStartMs: 1_100 },
  };
}

async function setup() {
  const vault = mockVault(unlocked());
  const storage = mockStorage('download');
  const blobs: Blob[] = [];
  (storage.env.createObjectURL as ReturnType<typeof vi.fn>).mockImplementation((b: Blob) => {
    blobs.push(b);
    return 'blob:log';
  });
  render(
    <App
      vault={vault.client}
      storage={storage.env}
      statusPollMs={60_000}
      balanceRefreshMs={60_000}
    />,
  );
  await screen.findByRole('heading', { name: 'Dziennik operacji' });
  return { vault, storage, blobs, user: userEvent.setup() };
}

describe('operations log panel', () => {
  it('empty: download buttons disabled', async () => {
    await setup();
    expect(screen.getByText(/Brak wpisów/u)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pobierz CSV' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Pobierz JSON' })).toHaveProperty('disabled', true);
  });

  it('counts events and downloads CSV and JSON with addresses and exact amounts', async () => {
    const { vault, storage, blobs, user } = await setup();
    act(() => {
      vault.emit(walletEvent(1, 'QUEUED'));
      vault.emit(walletEvent(1, 'CONFIRMED'));
    });
    expect(await screen.findByText(/Wpisów: 2\./u)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Pobierz CSV' }));
    await user.click(screen.getByRole('button', { name: 'Pobierz JSON' }));
    expect(storage.clickDownload).toHaveBeenCalledTimes(2);
    const names = storage.clickDownload.mock.calls.map((c) => (c as unknown[])[1]);
    expect(names[0]).toMatch(/^bunndly-log-3-.*\.csv$/u);
    expect(names[1]).toMatch(/^bunndly-log-3-.*\.json$/u);

    const csv = await blobs[0]?.text();
    expect(csv?.split('\r\n')).toHaveLength(4); // header, 2 rows, final line break
    expect(csv).toContain('Address1');
    expect(csv).toContain(",'=1+1,");
    expect(csv).toContain(',10000000,2101,');
    const json = JSON.parse((await blobs[1]?.text()) ?? '[]') as Record<string, unknown>[];
    expect(json[1]).toMatchObject({ state: 'CONFIRMED', address: 'Address1', received: '2101' });
  });
});
