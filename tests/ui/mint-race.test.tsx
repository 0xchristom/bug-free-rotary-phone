// @vitest-environment jsdom
/**
 * Answers for a mint that is no longer on screen must be ignored (review of BUNNDLY-14
 * part 1). Based on Andy's reproduction; vault answers are released by hand.
 */
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '../../src/core/errors.ts';
import { App } from '../../src/ui/App.tsx';
import type { VaultBalances, VaultRequest, VaultStatus } from '../../src/worker/protocol.ts';
import { TARGET_LABEL, TARGET_WAIT, fleetInfo, mockStorage, mockVault } from './fakes.ts';
import { setupUser } from './user.ts';

/**
 * Well-formed addresses the fake worker calls token mints (the target field checks the
 * address first, BUNNDLY-59). The names say the role each one plays in a test.
 */
const M = {
  WrongMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  GoodMint: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo',
  MintA: 'HEhuwZjGd8Za7jgjzzpsXJssnP89DQm4oYHghRpnpump',
  MintB: 'FQ6WmS5szfK1NRVcGkAqeVbwNeL9kt4xJXhwviyWTB7K',
  MintC: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  MintD: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  Bad: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
} as const;

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
    network: 'mainnet' as const,
    source: 'helius' as const,
    fetchedAt: '2026-10-02T12:00:00.000Z',
  };
}

function setup() {
  const info = fleetInfo(2);
  const status = (): VaultStatus => ({
    locked: false,
    network: 'mainnet',
    armed: false,
    info,
    buy: null,
    watch: null,
    groups: [],
  });
  const vault = mockVault(status());
  const pending = new Map<string, Deferred>();
  vault.request.mockImplementation((req: VaultRequest) => {
    if (req.type === 'status' || req.type === 'activity') return Promise.resolve(status());
    if (req.type === 'classifyTarget') {
      return Promise.resolve({ kind: 'mint', program: 'spl-token' } as const);
    }
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
  return { pending, vault, user: setupUser() };
}

/** Puts the address in the target field; a checked mint is read with the balances. */
async function submitMint(user: UserEvent, text: string) {
  const field = screen.getByLabelText(TARGET_LABEL);
  await user.clear(field);
  if (text === '') return;
  await user.type(field, text);
  await screen.findByText('Token · SPL', {}, TARGET_WAIT);
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
}

function tokenCell(label: string): string | null {
  const tr = screen.getByRole('checkbox', { name: `Select ${label}` }).closest('tr');
  if (!tr) throw new Error('row');
  // select, wallet, balance, buy amount, priority fee, slippage, fill, tokens
  return within(tr).getAllByRole('cell')[7]?.textContent ?? null;
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
    await screen.findByText(/^Balances as of /u);
    await submitMint(user, M.WrongMint);
    await waitFor(() => {
      expect(pending.has(M.WrongMint)).toBe(true);
    });
    await submitMint(user, M.GoodMint);
    act(() => {
      pending.get(M.WrongMint)?.reject(new AppError('NOT_A_TOKEN_MINT'));
    });
    await settle();
    // the new mint is still asked for
    await waitFor(() => {
      expect(pending.has(M.GoodMint)).toBe(true);
    });
    act(() => {
      pending.get(M.GoodMint)?.resolve(balancesFor(M.GoodMint, 6, 2_500_000n));
    });
    await settle();
    expect(alerts()).not.toContain('is not a token mint');
    expect(tokenCell('W01')).toBe('2.5');
  });

  it('a late answer for the old mint is not shown under the new mint', async () => {
    const { pending, user } = setup();
    await screen.findByText(/^Balances as of /u);
    await submitMint(user, M.MintA);
    await waitFor(() => {
      expect(pending.has(M.MintA)).toBe(true);
    });
    await submitMint(user, M.MintB);
    act(() => {
      pending.get(M.MintA)?.resolve(balancesFor(M.MintA, 0, 777n));
    });
    await settle();
    expect(screen.queryAllByText('777')).toHaveLength(0);
    await waitFor(() => {
      expect(pending.has(M.MintB)).toBe(true);
    });
    act(() => {
      pending.get(M.MintB)?.resolve(balancesFor(M.MintB, 0, 42n));
    });
    await settle();
    expect(tokenCell('W02')).toBe('42');
  });

  it('after clearing the field, late answers for the old mint (success or error) are ignored', async () => {
    const { pending, user, vault } = setup();
    await screen.findByText(/^Balances as of /u);
    await submitMint(user, M.MintC);
    await waitFor(() => {
      expect(pending.has(M.MintC)).toBe(true);
    });
    await submitMint(user, ''); // cleared: SOL only
    act(() => {
      pending.get(M.MintC)?.resolve(balancesFor(M.MintC, 0, 555n));
    });
    await settle();
    expect(screen.queryAllByText('555')).toHaveLength(0);
    expect(tokenCell('W01')).toBe('—');
    // the refresh without a mint went out after the stale answer
    const last = vault.request.mock.calls
      .map(([r]) => r)
      .filter((r) => r.type === 'refreshBalances')
      .at(-1);
    expect(last).toEqual({ type: 'refreshBalances' });

    // the same with an error for the old mint
    await submitMint(user, M.MintD);
    await waitFor(() => {
      expect(pending.has(M.MintD)).toBe(true);
    });
    await submitMint(user, '');
    act(() => {
      pending.get(M.MintD)?.reject(new AppError('NOT_A_TOKEN_MINT'));
    });
    await settle();
    expect(alerts()).not.toContain('is not a token mint');
  });

  it('a NOT_A_TOKEN_MINT for the current mint is still shown at the field', async () => {
    const { pending, user } = setup();
    await screen.findByText(/^Balances as of /u);
    await submitMint(user, M.Bad);
    await waitFor(() => {
      expect(pending.has(M.Bad)).toBe(true);
    });
    act(() => {
      pending.get(M.Bad)?.reject(new AppError('NOT_A_TOKEN_MINT'));
    });
    await settle();
    expect(alerts()).toContain('is not a token mint');
  });
});
