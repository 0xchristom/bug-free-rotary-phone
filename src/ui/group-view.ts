/**
 * Wallet groups on the fleet screen (BUNNDLY-69): what each group is doing, from the
 * worker's status, and the group changes the screen saves with `saveSettings`. The rules
 * a saved list must keep are in core/groups.ts; the worker checks them again.
 */
import { nextGroupId, type WalletGroupV1 } from '../core/groups.ts';
import type { GroupStatus } from '../worker/protocol.ts';
import type { Tone } from './kit/index.ts';

export type GroupState = 'idle' | 'armed' | 'buying' | 'selling' | 'stopped';

export const GROUP_STATE_LABELS: Record<GroupState, string> = {
  idle: 'Idle',
  armed: 'Armed',
  buying: 'Buying',
  selling: 'Selling',
  stopped: 'Stopped',
};

export const GROUP_STATE_TONES: Record<GroupState, Tone> = {
  idle: 'muted',
  armed: 'watch',
  buying: 'run',
  selling: 'danger',
  stopped: 'warn',
};

/**
 * The group's state as the worker reports it. A run after STOP is "Stopped" until its
 * sent transactions end; a group the worker does not list (yet) is idle.
 */
export function groupState(status: GroupStatus | undefined): GroupState {
  if (status === undefined) return 'idle';
  const { buy } = status;
  if (buy !== null) {
    if (!buy.accepting) return 'stopped';
    return buy.side === 'sell' ? 'selling' : 'buying';
  }
  return status.watch?.armed === true ? 'armed' : 'idle';
}

/** Where moved wallets go: a group the fleet has, or a new one with this name. */
export type MoveTarget = { readonly id: string } | { readonly name: string };

const ascending = (list: readonly number[]): number[] => [...list].sort((a, b) => a - b);

/**
 * The groups after moving `wallets` to `target`: out of every other group, into the
 * target. A new group gets the next free id and goes last. Groups left empty stay.
 */
export function moveWallets(
  groups: readonly WalletGroupV1[],
  wallets: readonly number[],
  target: MoveTarget,
): WalletGroupV1[] {
  const moving = new Set(wallets);
  const id = 'id' in target ? target.id : nextGroupId(groups);
  const kept = groups.map((g) =>
    g.id === id
      ? { ...g, wallets: ascending([...new Set([...g.wallets, ...moving])]) }
      : { ...g, wallets: g.wallets.filter((i) => !moving.has(i)) },
  );
  if ('id' in target) return kept;
  return [...kept, { id, name: target.name, wallets: ascending([...moving]) }];
}

export function renameGroup(
  groups: readonly WalletGroupV1[],
  id: string,
  name: string,
): WalletGroupV1[] {
  return groups.map((g) => (g.id === id ? { ...g, name } : g));
}

/**
 * The groups without `id`; its wallets go back to the first group, which therefore
 * cannot be deleted. Returns the groups unchanged for the first group or an unknown id.
 */
export function deleteGroup(groups: readonly WalletGroupV1[], id: string): WalletGroupV1[] {
  const [first, ...rest] = groups;
  const gone = rest.find((g) => g.id === id);
  if (first === undefined || gone === undefined) return [...groups];
  return [
    { ...first, wallets: ascending([...first.wallets, ...gone.wallets]) },
    ...rest.filter((g) => g.id !== id),
  ];
}

/** Sum of the known balances of these wallets; null while none is known. */
export function groupLamports(
  wallets: readonly number[],
  lamports: ReadonlyMap<number, bigint> | null,
): bigint | null {
  if (lamports === null) return null;
  let sum = 0n;
  let known = false;
  for (const i of wallets) {
    const balance = lamports.get(i);
    if (balance !== undefined) {
      sum += balance;
      known = true;
    }
  }
  return known ? sum : null;
}
