// @vitest-environment jsdom
/**
 * Answers for a mint that is no longer on screen must be ignored (review of BUNNDLY-14
 * part 1). Based on Andy's reproduction; vault answers are released by hand.
 */
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '../../src/core/errors.ts';
import { App } from '../../src/ui/App.tsx';
import type { VaultBalances, VaultRequest, VaultStatus } from '../../src/worker/protocol.ts';
import { fleetInfo, mockStorage, mockVault } from './fakes.ts';

interface Deferred {
  resolve: (v: VaultBalances) => void;
  reject: (e: unknown) => void;
}

function balancesFor(mint: string | undefined, decimals: number, perWallet: bigint): VaultBalances {
  const info = fleetInfo(2);
  return {
    balances: info.wallets.map((w) => ({ index: w.index, lamports: 1_000_000_000n })),
    ...(mint
      ? {
          token: {
            mint,
            program: 'spl-token' as const,
            decimals,
            balances: info.wallets.map((w) => ({ index: w.index, amount: perWallet })),
          },
        }
      : {}),
    source: 'helius' as const,
    fetchedAt: '2026-10-02T12:00:00.000Z',
  };
}

function setup() {
  const info = fleetInfo(2);
  const status = (): VaultStatus => ({ locked: false, armed: false, info, buy: null, watch: null });
  const vault = mockVault(status());
  const pending = new Map<string, Deferred>();
  vault.request.mockImplementation((req: VaultRequest) => {
    if (req.type === 'status' || req.type === 'activity') return Promise.resolve(status());
    if (req.type === 'refreshBalances') {
      const mint = req.mint;
      if (mint === undefined) return Promise.resolve(balancesFor(undefined, 0, 0n));
      return new Promise((resolve, reject) => {
        pending.set(mint, { resolve, reject });
      });
    }
    return Promise.reject(new AppError('INTERNAL_ERROR'));
  });
  render(
    <App
      vault={vault.client}
      storage={mockStorage().env}
      statusPollMs={60_000}
      balanceRefreshMs={60_000}
    />,
  );
  return { pending, vault, user: userEvent.setup() };
}

async function submitMint(user: ReturnType<typeof userEvent.setup>, text: string) {
  const field = screen.getByLabelText('Adres tokenu (mint)');
  await user.clear(field);
  if (text !== '') await user.type(field, text);
  await user.click(screen.getByRole('button', { name: 'Pokaż saldo tokenu' }));
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
}

function tokenCell(label: string): string | null {
  const tr = screen.getByRole('cell', { name: label }).closest('tr');
  if (!tr) throw new Error('row');
  return within(tr).getAllByRole('cell')[6]?.textContent ?? null;
}

function alerts(): string {
  return screen
    .queryAllByRole('alert')
    .map((a) => a.textContent)
    .join(' | ');
}

afterEach(cleanup);

describe('stale mint answers', () => {
  it('a late NOT_A_TOKEN_MINT for the old mint does not drop the new, valid mint', async () => {
    const { pending, user } = setup();
    await screen.findByText(/^Salda z /u);
    await submitMint(user, 'WrongMint');
    await waitFor(() => {
      expect(pending.has('WrongMint')).toBe(true);
    });
    await submitMint(user, 'GoodMint');
    act(() => {
      pending.get('WrongMint')?.reject(new AppError('NOT_A_TOKEN_MINT'));
    });
    await settle();
    // the new mint is still asked for
    await waitFor(() => {
      expect(pending.has('GoodMint')).toBe(true);
    });
    act(() => {
      pending.get('GoodMint')?.resolve(balancesFor('GoodMint', 6, 2_500_000n));
    });
    await settle();
    expect(alerts()).not.toContain('nie jest mintem tokenu');
    expect(tokenCell('W01')).toBe('2,5');
  });

  it('a late answer for the old mint is not shown under the new mint', async () => {
    const { pending, user } = setup();
    await screen.findByText(/^Salda z /u);
    await submitMint(user, 'MintA');
    await waitFor(() => {
      expect(pending.has('MintA')).toBe(true);
    });
    await submitMint(user, 'MintB');
    act(() => {
      pending.get('MintA')?.resolve(balancesFor('MintA', 0, 777n));
    });
    await settle();
    expect(screen.queryAllByText('777')).toHaveLength(0);
    await waitFor(() => {
      expect(pending.has('MintB')).toBe(true);
    });
    act(() => {
      pending.get('MintB')?.resolve(balancesFor('MintB', 0, 42n));
    });
    await settle();
    expect(tokenCell('W02')).toBe('42');
  });

  it('after clearing the field, late answers for the old mint (success or error) are ignored', async () => {
    const { pending, user, vault } = setup();
    await screen.findByText(/^Salda z /u);
    await submitMint(user, 'MintC');
    await waitFor(() => {
      expect(pending.has('MintC')).toBe(true);
    });
    await submitMint(user, ''); // cleared: SOL only
    act(() => {
      pending.get('MintC')?.resolve(balancesFor('MintC', 0, 555n));
    });
    await settle();
    expect(screen.queryAllByText('555')).toHaveLength(0);
    expect(tokenCell('W01')).toBe('–');
    // the refresh without a mint went out after the stale answer
    const last = vault.request.mock.calls
      .map(([r]) => r)
      .filter((r) => r.type === 'refreshBalances')
      .at(-1);
    expect(last).toEqual({ type: 'refreshBalances' });

    // the same with an error for the old mint
    await submitMint(user, 'MintD');
    await waitFor(() => {
      expect(pending.has('MintD')).toBe(true);
    });
    await submitMint(user, '');
    act(() => {
      pending.get('MintD')?.reject(new AppError('NOT_A_TOKEN_MINT'));
    });
    await settle();
    expect(alerts()).not.toContain('nie jest mintem tokenu');
  });

  it('a NOT_A_TOKEN_MINT for the current mint is still shown at the field', async () => {
    const { pending, user } = setup();
    await screen.findByText(/^Salda z /u);
    await submitMint(user, 'Bad');
    await waitFor(() => {
      expect(pending.has('Bad')).toBe(true);
    });
    act(() => {
      pending.get('Bad')?.reject(new AppError('NOT_A_TOKEN_MINT'));
    });
    await settle();
    expect(alerts()).toContain('nie jest mintem tokenu');
  });
});
