/**
 * Wallet group rules (BUNNDLY-68): every wallet in exactly one group, unique ids and
 * names; an empty list is one group with every wallet.
 */
import { describe, expect, it } from 'vitest';
import {
  effectiveGroups,
  groupOf,
  isGroupName,
  nextGroupId,
  validateGroups,
  withNewWallets,
  type WalletGroupV1,
} from '../../src/core/groups.ts';

const fleet = new Set([0, 1, 2, 3, 4, 5, 6, 7]);
const a: WalletGroupV1 = { id: 'g1', name: 'A', wallets: [0, 1, 2] };
const b: WalletGroupV1 = { id: 'g2', name: 'B', wallets: [3, 4, 5, 6, 7] };
const ab = [a, b];
const fieldsOf = (groups: WalletGroupV1[], wallets = fleet): string[] =>
  validateGroups(groups, wallets).map((p) => p.field);

describe('wallet groups', () => {
  it('no groups = one group "All wallets" with every wallet, ascending', () => {
    expect(effectiveGroups([], [2, 0, 1])).toEqual([
      { id: 'g1', name: 'All wallets', wallets: [0, 1, 2] },
    ]);
    expect(effectiveGroups(ab, fleet)).toBe(ab);
    expect(validateGroups([], fleet)).toEqual([]);
  });

  it('A = {0,1,2}, B = {3..7} is valid; each wallet maps to its group', () => {
    expect(validateGroups(ab, fleet)).toEqual([]);
    expect([0, 2, 3, 7].map((i) => groupOf(ab, i))).toEqual(['g1', 'g1', 'g2', 'g2']);
    expect(groupOf(ab, 8)).toBeUndefined();
  });

  it('a wallet in two groups is refused', () => {
    const two = [a, { ...b, wallets: [2, 3, 4, 5, 6, 7] }];
    expect(fieldsOf(two)).toEqual(['wallet.2']);
  });

  it('a wallet in no group, or not in the fleet, is refused', () => {
    expect(fieldsOf([a, { ...b, wallets: [3, 4, 5, 6] }])).toEqual(['wallet.7']);
    expect(fieldsOf([a, { ...b, wallets: [3, 4, 5, 6, 7, 8] }])).toEqual(['wallet.8']);
  });

  it('an empty group is allowed (made first, filled later)', () => {
    expect(validateGroups([...ab, { id: 'g3', name: 'C', wallets: [] }], fleet)).toEqual([]);
  });

  it('ids: g<number>, unique', () => {
    expect(fieldsOf([{ ...a, id: 'x1' }, b])).toEqual(['group.x1.id']);
    expect(fieldsOf([a, { ...b, id: 'g1' }])).toEqual(['group.g1.id']);
    expect(fieldsOf([{ ...a, id: 'g0' }, b])).toEqual(['group.g0.id']);
  });

  it('names: 1-32 characters, no spaces at the ends, unique regardless of case', () => {
    expect(isGroupName('x'.repeat(32))).toBe(true);
    expect(isGroupName('x'.repeat(33))).toBe(false);
    expect(isGroupName('')).toBe(false);
    expect(isGroupName(' A')).toBe(false);
    expect(isGroupName('A\u0007')).toBe(false);
    expect(isGroupName('Snipers 2')).toBe(true);
    expect(isGroupName('ż'.repeat(32))).toBe(true);
    expect(fieldsOf([a, { ...b, name: 'a' }])).toEqual(['group.g2.name']);
  });

  it('more than 64 groups is refused', () => {
    const many = Array.from({ length: 65 }, (_, i) => ({
      id: `g${String(i + 1)}`,
      name: `G${String(i + 1)}`,
      wallets: i < 8 ? [i] : [],
    }));
    expect(fieldsOf(many)).toEqual(['groups']);
    expect(fieldsOf(many.slice(0, 64))).toEqual([]);
  });

  it('the next id is one more than the highest, never a reused one', () => {
    expect(nextGroupId([])).toBe('g1');
    expect(nextGroupId([{ id: 'g7', name: 'X', wallets: [] }, a])).toBe('g8');
  });

  it('new wallets go to the first group; the default covers them already', () => {
    expect(withNewWallets(ab, [9, 8])).toEqual([
      { id: 'g1', name: 'A', wallets: [0, 1, 2, 8, 9] },
      b,
    ]);
    expect(withNewWallets([], [8])).toEqual([]);
  });
});
