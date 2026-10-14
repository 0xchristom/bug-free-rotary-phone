/** Group helpers of the dashboard (BUNNDLY-69), cases from the review of 69 (G4, G5). */
import { describe, expect, it } from 'vitest';
import type { WalletGroupV1 } from '../../src/core/index.ts';
import { deleteGroup, groupLamports } from '../../src/ui/group-view.ts';

const GROUPS: WalletGroupV1[] = [
  { id: 'g1', name: 'Team A', wallets: [0, 1] },
  { id: 'g2', name: 'Team B', wallets: [2, 3] },
  { id: 'g3', name: 'Team C', wallets: [4] },
];

describe('deleteGroup', () => {
  it('the first group cannot be deleted: the list comes back unchanged', () => {
    expect(deleteGroup(GROUPS, 'g1')).toEqual(GROUPS);
  });

  it('another group gives its wallets to the first group, in index order', () => {
    expect(deleteGroup(GROUPS, 'g2')).toEqual([
      { id: 'g1', name: 'Team A', wallets: [0, 1, 2, 3] },
      { id: 'g3', name: 'Team C', wallets: [4] },
    ]);
  });

  it('an unknown id changes nothing', () => {
    expect(deleteGroup(GROUPS, 'g9')).toEqual(GROUPS);
  });
});

describe('groupLamports', () => {
  it('no known balance in the group is null ("—" on the tab), not 0', () => {
    const lamports = new Map<number, bigint>([[0, 5n]]);
    expect(groupLamports([2, 3], lamports)).toBeNull();
    expect(groupLamports([], lamports)).toBeNull();
    expect(groupLamports([2, 3], null)).toBeNull();
  });

  it('sums the known balances only: 1.5 SOL + 0.25 SOL = 1 750 000 000 lamports', () => {
    const lamports = new Map<number, bigint>([
      [2, 1_500_000_000n],
      [3, 250_000_000n],
    ]);
    // wallet 4 has no read yet: it adds nothing
    expect(groupLamports([2, 3, 4], lamports)).toBe(1_750_000_000n);
  });

  it('a known zero balance is 0, not null', () => {
    expect(groupLamports([2], new Map([[2, 0n]]))).toBe(0n);
  });
});
