/**
 * Wallet groups (BUNNDLY-68): named sets of wallets that buy, watch and sell on their own.
 * Dependency-free, so the form and the vault worker validate with the same rules (D-019).
 *
 * Every wallet is in exactly one group. An empty list is the fleet from before groups:
 * one group with every wallet. That default is not written to the file.
 */

export interface WalletGroupV1 {
  /** Assigned by the worker: `g1`, `g2`, … Never reused within a file. */
  readonly id: string;
  readonly name: string;
  /** Wallet indices, ascending. A group may be empty. */
  readonly wallets: readonly number[];
}

export const GROUP_LIMITS = {
  nameLength: { min: 1, max: 32 },
  count: { max: 64 },
} as const;

/** The id of the one group a fleet from before groups has. */
export const DEFAULT_GROUP_ID = 'g1';
export const DEFAULT_GROUP_NAME = 'All wallets';

const GROUP_ID = /^g[1-9][0-9]{0,3}$/u;

export function isGroupId(value: unknown): value is string {
  return typeof value === 'string' && GROUP_ID.test(value);
}

/** 1-32 characters (code points), no control characters, no spaces at the ends. */
const GROUP_NAME = /^[^\p{Cc}]{1,32}$/u;

export function isGroupName(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim() && GROUP_NAME.test(value);
}

/**
 * The groups the fleet works with: the saved ones, or for an empty list one group with
 * every wallet. `walletIndices` in any order; the default group lists them ascending.
 */
export function effectiveGroups(
  groups: readonly WalletGroupV1[],
  walletIndices: Iterable<number>,
): readonly WalletGroupV1[] {
  if (groups.length > 0) return groups;
  return [
    {
      id: DEFAULT_GROUP_ID,
      name: DEFAULT_GROUP_NAME,
      wallets: [...walletIndices].sort((a, b) => a - b),
    },
  ];
}

/** The id of the group the wallet is in, or undefined for a wallet not in the fleet. */
export function groupOf(groups: readonly WalletGroupV1[], index: number): string | undefined {
  return groups.find((g) => g.wallets.includes(index))?.id;
}

/** The next free id: one more than the highest in use. */
export function nextGroupId(groups: readonly WalletGroupV1[]): string {
  let max = 0;
  for (const g of groups) {
    if (isGroupId(g.id)) max = Math.max(max, Number(g.id.slice(1)));
  }
  return `g${String(max + 1)}`;
}

export interface GroupProblem {
  /** `groups`, or `group.<id>.<field>`, or `wallet.<index>`. */
  readonly field: string;
  /** English message for the form. */
  readonly message: string;
}

const MESSAGES = {
  count: 'There can be at most 64 groups.',
  id: 'This group has an invalid id.',
  duplicateId: 'Two groups have the same id.',
  name: 'A group name must have 1 to 32 characters, without spaces at the ends.',
  duplicateName: 'Two groups have the same name.',
  unknownWallet: 'This wallet is not in the fleet.',
  twoGroups: 'A wallet can be in only one group.',
  noGroup: 'Every wallet must be in a group.',
} as const;

/**
 * Checks the groups against the fleet's wallets. Empty list = valid; the worker refuses
 * anything else (INVALID_SETTINGS). An empty `groups` list is always valid (the default).
 */
export function validateGroups(
  groups: readonly WalletGroupV1[],
  walletIndices: ReadonlySet<number>,
): GroupProblem[] {
  if (groups.length === 0) return [];
  const problems: GroupProblem[] = [];
  const add = (field: string, message: string): void => {
    problems.push({ field, message });
  };
  if (groups.length > GROUP_LIMITS.count.max) add('groups', MESSAGES.count);

  const ids = new Set<string>();
  const names = new Set<string>();
  const owner = new Map<number, string>();
  for (const g of groups) {
    const prefix = `group.${g.id}`;
    if (!isGroupId(g.id)) add(`${prefix}.id`, MESSAGES.id);
    else if (ids.has(g.id)) add(`${prefix}.id`, MESSAGES.duplicateId);
    ids.add(g.id);
    if (!isGroupName(g.name)) add(`${prefix}.name`, MESSAGES.name);
    else {
      const key = g.name.toLowerCase();
      if (names.has(key)) add(`${prefix}.name`, MESSAGES.duplicateName);
      names.add(key);
    }
    for (const index of g.wallets) {
      if (!walletIndices.has(index)) add(`wallet.${String(index)}`, MESSAGES.unknownWallet);
      else if (owner.has(index)) add(`wallet.${String(index)}`, MESSAGES.twoGroups);
      else owner.set(index, g.id);
    }
  }
  for (const index of walletIndices) {
    if (!owner.has(index)) add(`wallet.${String(index)}`, MESSAGES.noGroup);
  }
  return problems;
}

/**
 * New wallets (added to the fleet) go to the first group. The default (empty list)
 * covers them already.
 */
export function withNewWallets(
  groups: readonly WalletGroupV1[],
  added: readonly number[],
): readonly WalletGroupV1[] {
  const [first, ...rest] = groups;
  if (first === undefined || added.length === 0) return groups;
  return [{ ...first, wallets: [...first.wallets, ...added].sort((a, b) => a - b) }, ...rest];
}
