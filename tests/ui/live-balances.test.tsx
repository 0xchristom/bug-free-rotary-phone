// @vitest-environment jsdom
/**
 * Live balances on screen (BUNNDLY-57, D-055): a `balance` event for wallet k changes only
 * row k, to the lamports of the event, and flashes only that cell; the rail and the column
 * say "Polling" until the worker says "Live"; going live reads everything once more, and
 * polling reads again every interval; an event of a network not on screen is dropped.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Network } from '../../src/core/network.ts';
import { App } from '../../src/ui/App.tsx';
import type { VaultRequest, VaultStatus, WorkerEvent } from '../../src/worker/protocol.ts';
import { fleetInfo, mockStorage, mockVault } from './fakes.ts';
import { eventually } from './settle.ts';

const SOL = 1_000_000_000n;
/** Column of the SOL balance in the wallet table. */
const BALANCE = 2;

function setup({
  count = 3,
  probe,
  refreshMs = 60_000,
}: {
  readonly count?: number;
  readonly probe?: (index: number) => void;
  readonly refreshMs?: number;
} = {}) {
  const info = fleetInfo(count);
  const status: VaultStatus = {
    locked: false,
    network: 'mainnet',
    armed: false,
    info,
    buy: null,
    watch: null,
    groups: [],
  };
  const vault = mockVault(status);
  const reads: number[] = [];
  vault.request.mockImplementation((req: VaultRequest) => {
    switch (req.type) {
      case 'status':
      case 'activity':
        return Promise.resolve(status);
      case 'balanceFeed':
        // the worker opens the socket; the subscriptions are not confirmed yet
        return Promise.resolve({ network: 'mainnet', state: 'polling' });
      case 'refreshBalances':
        reads.push(performance.now());
        return Promise.resolve({
          network: 'mainnet',
          balances: info.wallets.map((w) => ({ index: w.index, lamports: SOL })),
          source: 'helius',
          fetchedAt: '2026-10-14T12:00:00.000Z',
        });
      default:
        return Promise.reject(new Error(req.type));
    }
  });
  render(
    <App
      vault={vault.client}
      storage={mockStorage().env}
      statusPollMs={60_000}
      balanceRefreshMs={refreshMs}
      {...(probe ? { rowProbe: probe } : {})}
    />,
  );
  const emit = (event: WorkerEvent) => {
    act(() => {
      vault.emit(event);
    });
  };
  const sol = (index: number, lamports: bigint, network: Network = 'mainnet') => {
    emit({ kind: 'balance', network, type: 'sol', index, lamports });
  };
  const feed = (state: 'live' | 'polling') => {
    emit({ kind: 'balance', network: 'mainnet', type: 'feed', state });
  };
  return { vault, reads, sol, feed };
}

function row(label: string): HTMLElement {
  const tr = document.querySelector(`input[aria-label="Select ${label}"]`)?.closest('tr');
  if (!tr) throw new Error(`row ${label}`);
  return tr;
}

const cells = (label: string): string[] => [...row(label).children].map((c) => c.textContent);
const flashing = (): string[] =>
  [...document.querySelectorAll('.bal-flash')].map(
    (el) => el.closest('tr')?.querySelector('.w-name')?.textContent ?? '?',
  );
const rail = (): string => screen.getByRole('contentinfo', { name: 'Status' }).textContent;
const columnTag = (): string | null => document.querySelector('.feed-tag')?.textContent ?? null;

async function ready(): Promise<void> {
  await eventually(() => screen.getByText(/^Balances as of /u));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('live balances in the table', () => {
  it('an event for wallet k changes row k only, to its lamports, and flashes that cell only', async () => {
    const renders = new Map<number, number>();
    const probe = (index: number): void => {
      renders.set(index, (renders.get(index) ?? 0) + 1);
    };
    const t = setup({ count: 100, probe });
    await ready();
    await waitFor(() => {
      expect(cells('W100')[BALANCE]).toBe('1');
    });
    const before = new Map(renders);
    t.sol(42, 2_718_281_828n);
    await waitFor(() => {
      expect(cells('W43')[BALANCE]).toBe('2.718281828');
    });
    const changed = [...renders].filter(([i, n]) => n !== before.get(i)).map(([i]) => i);
    expect(changed).toEqual([42]);
    expect(renders.get(42)).toBe((before.get(42) ?? 0) + 1);
    expect(cells('W42')[BALANCE]).toBe('1');
    expect(cells('W44')[BALANCE]).toBe('1');
    expect(flashing()).toEqual(['W43']);
  }, 30_000);

  it('the same value again changes nothing and renders nothing', async () => {
    const renders = new Map<number, number>();
    const t = setup({
      count: 3,
      probe: (i) => renders.set(i, (renders.get(i) ?? 0) + 1),
    });
    await ready();
    await waitFor(() => {
      expect(cells('W01')[BALANCE]).toBe('1');
    });
    const before = new Map(renders);
    t.sol(0, SOL);
    await act(() => Promise.resolve());
    expect(renders).toEqual(before);
    expect(flashing()).toEqual([]);
  });

  it('network guard: an event read on another network than the one on screen is dropped', async () => {
    const t = setup({ count: 3 });
    await ready();
    await waitFor(() => {
      expect(cells('W02')[BALANCE]).toBe('1');
    });
    t.sol(1, 9n * SOL, 'devnet');
    await act(() => Promise.resolve());
    expect(cells('W02')[BALANCE]).toBe('1');
    t.sol(1, 9n * SOL, 'mainnet');
    await waitFor(() => {
      expect(cells('W02')[BALANCE]).toBe('9');
    });
  });
});

describe('live or polling', () => {
  it('polling is said as polling until the worker says live; going live reads once; polling reads again', async () => {
    const t = setup({ count: 3, refreshMs: 150 });
    await ready();
    // the worker answered `polling`: never shown as live
    expect(rail()).toContain('Balances: Polling');
    expect(rail()).not.toContain('Balances: Live');
    expect(columnTag()).toBe('Polling');
    // polling: a full read every interval
    const first = t.reads.length;
    await waitFor(() => {
      expect(t.reads.length).toBeGreaterThanOrEqual(first + 2);
    });

    const beforeLive = t.reads.length;
    t.feed('live');
    expect(rail()).toContain('Balances: Live');
    expect(columnTag()).toBe('Live');
    // one reconciliation right away, then nothing for 30 s
    await waitFor(() => {
      expect(t.reads.length).toBe(beforeLive + 1);
    });
    await act(
      () =>
        new Promise((resolve) => {
          setTimeout(resolve, 600);
        }),
    );
    expect(t.reads.length).toBe(beforeLive + 1);

    // the socket is lost: polling again, and the reads resume
    t.feed('polling');
    expect(rail()).toContain('Balances: Polling');
    expect(columnTag()).toBe('Polling');
    await waitFor(() => {
      expect(t.reads.length).toBeGreaterThanOrEqual(beforeLive + 3);
    });
  });

  it('the screen asks the worker for the feed and closes it when it goes', async () => {
    const t = setup({ count: 2 });
    await ready();
    const asked = () =>
      t.vault.request.mock.calls
        .map(([r]) => r)
        .filter(
          (r): r is Extract<VaultRequest, { type: 'balanceFeed' }> => r.type === 'balanceFeed',
        )
        .map((r) => r.on);
    expect(asked()).toEqual([true]);
    cleanup();
    expect(asked()).toEqual([true, false]);
  });
});
