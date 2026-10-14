// @vitest-environment jsdom
/**
 * Operations log (BUNNDLY-25): counts events, downloads CSV/JSON. Since BUNNDLY-73 it lives on
 * the Activity screen; the Dashboard has none of the old panels.
 */
import { act, cleanup, render, screen, within } from '@testing-library/react';
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
  await screen.findByRole('heading', { name: 'Fleet' });
  const user = userEvent.setup();
  await user.click(
    within(screen.getByRole('navigation')).getByRole('button', { name: 'Activity' }),
  );
  await screen.findByRole('heading', { name: 'Operations log' });
  return { vault, storage, blobs, user };
}

// The texts of the panels the Dashboard had before mockup v2 (BUNNDLY-73).
const OLD_PANELS = ['Mode A', 'Mode B', 'Show token balance', 'Operations log', 'Refresh balances'];

describe('the Dashboard and the Activity screen (BUNNDLY-73)', () => {
  it('the Dashboard has none of the old panels', async () => {
    const vault = mockVault(unlocked());
    render(<App vault={vault.client} storage={mockStorage().env} />);
    await screen.findByRole('heading', { name: 'Fleet' });
    await screen.findByText('1.5');
    const text = document.body.textContent;
    for (const old of OLD_PANELS) expect(text, old).not.toContain(old);
    for (const old of OLD_PANELS) {
      expect(screen.queryByRole('button', { name: old }), old).toBeNull();
      expect(screen.queryByRole('heading', { name: old }), old).toBeNull();
    }
  });

  it('Activity shows the log with its download buttons, the Dashboard comes back from the nav', async () => {
    const { user } = await setup();
    const nav = screen.getByRole('navigation');
    expect(within(nav).getByRole('button', { name: 'Activity' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(screen.getByRole('heading', { name: 'Activity' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download CSV' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download JSON' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Watcher detections' })).toBeTruthy();
    // No commands on Activity: the target strip and the table stay on the Dashboard.
    expect(screen.queryByRole('region', { name: 'Commands' })).toBeNull();
    await user.click(within(nav).getByRole('button', { name: 'Dashboard' }));
    await screen.findByRole('heading', { name: 'Fleet' });
    expect(screen.queryByRole('heading', { name: 'Operations log' })).toBeNull();
  });
});

describe('operations log on the Activity screen', () => {
  it('empty: download buttons disabled', async () => {
    await setup();
    expect(screen.getByText(/No entries/u)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download CSV' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: 'Download JSON' })).toHaveProperty('disabled', true);
  });

  it('counts events and downloads CSV and JSON with addresses and exact amounts', async () => {
    const { vault, storage, blobs, user } = await setup();
    act(() => {
      vault.emit(walletEvent(1, 'QUEUED'));
      vault.emit(walletEvent(1, 'CONFIRMED'));
    });
    expect(await screen.findByText(/Entries: 2\./u)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Download CSV' }));
    await user.click(screen.getByRole('button', { name: 'Download JSON' }));
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
