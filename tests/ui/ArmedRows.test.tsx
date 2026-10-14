// @vitest-environment jsdom
/**
 * Rows of an armed group (BUNNDLY-88, mockup v2): each selected wallet says "Armed" and
 * "Waiting for the creator’s token" until DISARM; the In flight tab counts them as Fleet
 * fill does. The worker's status comes from a mock that DISARM changes.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App.tsx';
import type { WatchStatus } from '../../src/watcher/watch.ts';
import type { VaultInfo, VaultRequest, VaultStatus } from '../../src/worker/protocol.ts';
import { fleetInfo, mockStorage, mockVault, withDefaultGroup } from './fakes.ts';
import { setupUser } from './user.ts';

afterEach(cleanup);

const CREATOR = 'FQ6WmS5szfK1NRVcGkAqeVbwNeL9kt4xJXhwviyWTB7K';
const WAITING = 'Waiting for the creator’s token';

function setup() {
  const base = fleetInfo(3);
  const info: VaultInfo = {
    ...base,
    settings: {
      ...base.settings,
      maxSpend: base.wallets.map((w) => ({ index: w.index, lamports: 10_000_000n })),
      // W03 is not selected: it is in the group but not armed
      active: [{ index: 2, active: false }],
    },
    apiKeys: { ...base.apiKeys, helius: true },
  };
  let watch: WatchStatus | null = {
    creator: CREATOR,
    armedAt: '2026-10-14T12:00:00.000Z',
    mode: 'one-shot',
    armed: true,
    connection: 'connected',
    attempt: 0,
    lastMessageAt: null,
    detections: [],
    queued: [],
  };
  const status = (): VaultStatus => ({
    locked: false,
    network: 'mainnet',
    armed: watch?.armed ?? false,
    info,
    buy: null,
    watch,
    groups: [],
  });
  const vault = mockVault(status());
  vault.request.mockImplementation((req: VaultRequest) => {
    switch (req.type) {
      case 'status':
      case 'activity':
        return Promise.resolve(withDefaultGroup(status()));
      case 'refreshBalances':
        return Promise.resolve({
          balances: info.wallets.map((w) => ({ index: w.index, lamports: 1_000_000_000n })),
          network: 'mainnet',
          source: 'helius',
          fetchedAt: '2026-10-14T12:00:00.000Z',
        });
      case 'disarm':
        if (watch) watch = { ...watch, armed: false, connection: 'disconnected' };
        return Promise.resolve(withDefaultGroup(status()));
      default:
        return Promise.reject(new Error(req.type));
    }
  });
  render(
    <App
      vault={vault.client}
      storage={mockStorage().env}
      statusPollMs={60_000}
      balanceRefreshMs={60_000}
    />,
  );
  return { user: setupUser() };
}

function row(label: string): HTMLElement {
  const tr = document.querySelector(`input[aria-label="Select ${label}"]`)?.closest('tr');
  if (!tr) throw new Error(`row ${label}`);
  return tr;
}

/** The state cell of a row: its chip and the caption under it. */
function stateOf(label: string): string {
  return row(label).querySelector('td.c-status')?.textContent ?? '';
}

function tabCount(label: string): string {
  const tab = within(screen.getByRole('group', { name: 'Wallet filters' })).getByRole('button', {
    name: new RegExp(`^${label} \\d+$`, 'u'),
  });
  return tab.querySelector('.tab-count')?.textContent ?? '';
}

describe('rows of an armed group', () => {
  it('selected wallets are Armed and wait for the token; In flight counts them like Fleet fill; DISARM brings Ready back', async () => {
    const { user } = setup();
    await screen.findByText(/^Balances as of /u);
    await waitFor(() => {
      expect(stateOf('W01')).toBe(`Armed${WAITING}`);
    });
    expect(stateOf('W02')).toBe(`Armed${WAITING}`);
    // not selected: not armed, its chip as before
    expect(stateOf('W03')).toBe('Not selected');
    // the Fill column says the same for the armed rows
    expect(within(row('W01')).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0');
    expect(screen.getByText(/^Fleet fill · 0 of 2 filled · 2 in flight$/u)).toBeTruthy();
    expect(tabCount('In flight')).toBe('2');

    await user.click(screen.getByRole('button', { name: 'Disarm' }));
    await waitFor(() => {
      expect(stateOf('W01')).toBe('Ready');
    });
    expect(stateOf('W02')).toBe('Ready');
    expect(tabCount('In flight')).toBe('0');
    expect(screen.getByText(/^Fleet fill · 0 of 2 filled$/u)).toBeTruthy();
  });
});
