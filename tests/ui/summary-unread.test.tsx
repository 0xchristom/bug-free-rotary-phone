// @vitest-environment jsdom
/**
 * BUNNDLY-81: the summary under the table says "—" for Fleet balance and Planned buy until
 * the balances are read, like the balance chip and the group tabs; then the sums.
 */
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/ui/App.tsx';
import type { VaultInfo, VaultRequest, VaultStatus } from '../../src/worker/protocol.ts';
import { fleetInfo, mockStorage, mockVault, withDefaultGroup } from './fakes.ts';
import { eventually } from './settle.ts';

afterEach(cleanup);

const SOL = 1_000_000_000n;
/** 0.02 SOL per wallet. */
const SPEND = 20_000_000n;

function setup() {
  const base = fleetInfo(3);
  const info: VaultInfo = {
    ...base,
    settings: {
      ...base.settings,
      maxSpend: base.wallets.map((w) => ({ index: w.index, lamports: SPEND })),
    },
    apiKeys: { ...base.apiKeys, helius: true },
  };
  const status: VaultStatus = {
    locked: false,
    network: info.settings.global.network,
    armed: false,
    info,
    buy: null,
    watch: null,
    groups: [],
  };
  const vault = mockVault(status);
  let answer: (() => void) | null = null;
  vault.request.mockImplementation((req: VaultRequest) => {
    switch (req.type) {
      case 'status':
      case 'activity':
        return Promise.resolve(withDefaultGroup(status));
      case 'refreshBalances':
        // held until the test lets it through
        return new Promise((resolve) => {
          answer = () => {
            resolve({
              balances: info.wallets.map((w) => ({ index: w.index, lamports: SOL })),
              network: info.settings.global.network,
              source: 'helius',
              fetchedAt: '2026-10-14T12:00:00.000Z',
            });
          };
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
      balanceRefreshMs={60_000}
    />,
  );
  return {
    read: () => {
      if (answer === null) throw new Error('no balance read asked');
      answer();
    },
    asked: () => answer !== null,
  };
}

function summaryValue(name: string): string | null {
  const summary = screen.getByLabelText('Fleet summary');
  const term = within(summary).getByText(name, { selector: 'dt' });
  return term.nextElementSibling?.textContent ?? null;
}

describe('summary before the first balance read (BUNNDLY-81)', () => {
  it('"—" for Fleet balance and Planned buy until read; then 3 × 1 SOL and 3 × 0.02 SOL', async () => {
    const t = setup();
    await eventually(() => {
      expect(t.asked()).toBe(true);
    });
    expect(summaryValue('Fleet balance')).toBe('—');
    expect(summaryValue('Planned buy')).toBe('—');
    await act(async () => {
      t.read();
      await Promise.resolve();
    });
    // worked out by hand: 3 wallets × 1 SOL = 3 SOL; 3 × 0.02 SOL = 0.06 SOL
    await eventually(() => {
      expect(summaryValue('Fleet balance')).toBe('3 SOL');
    });
    expect(summaryValue('Planned buy')).toBe('0.06 SOL');
  });
});
