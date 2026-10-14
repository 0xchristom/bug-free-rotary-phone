/**
 * Wallet groups in the encrypted part of the fleet file (BUNNDLY-68): a file from before
 * opens with one group and is written without groups; a broken rule resets to that one
 * group; the shape stays strict.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createKeystore,
  parseSecrets,
  secretsToJson,
  type KeystoreSecretsV1,
} from '../../../src/core/index.ts';

let secrets: KeystoreSecretsV1;

beforeAll(async () => {
  secrets = (await createKeystore({ fleetName: 'Grupy', walletCount: 4, password: 'x'.repeat(12) }))
    .secrets;
});

const json = (): Record<string, unknown> =>
  JSON.parse(secretsToJson(secrets)) as Record<string, unknown>;

function withGroups(groups: unknown): Record<string, unknown> {
  const raw = json();
  raw.settings = { ...(raw.settings as object), groups };
  return raw;
}

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (e) {
    return (e as { code?: string }).code;
  }
};

const two = [
  { id: 'g1', name: 'Snipers', wallets: [0, 1] },
  { id: 'g3', name: 'Rest', wallets: [2, 3] },
];

describe('wallet groups in the fleet file', () => {
  it('a file from before has no groups, opens with none and is written without them', () => {
    const raw = json();
    expect(raw.settings).not.toHaveProperty('groups');
    const read = parseSecrets(raw);
    expect(read.settings.groups).toEqual([]);
    expect(read.settings.resetGroups).toBeUndefined();
    expect(JSON.parse(secretsToJson(read))).toEqual(raw);
  });

  it('round-trips groups as written', () => {
    const text = secretsToJson({ ...secrets, settings: { ...secrets.settings, groups: two } });
    expect(text).toContain(
      '"groups":[{"id":"g1","name":"Snipers","wallets":[0,1]},{"id":"g3","name":"Rest","wallets":[2,3]}]',
    );
    const read = parseSecrets(JSON.parse(text));
    expect(read.settings.groups).toEqual(two);
    expect(read.settings.resetGroups).toBeUndefined();
  });

  it.each([
    ['a wallet in two groups', [two[0], { ...two[1], wallets: [1, 2, 3] }]],
    ['a wallet in no group', [two[0], { ...two[1], wallets: [2] }]],
    ['a name taken twice', [two[0], { ...two[1], name: 'snipers' }]],
    ['an id that is not g<number>', [two[0], { ...two[1], id: 'rest' }]],
  ])('%s: every wallet back in one group, reported', (_name, groups) => {
    const { settings } = parseSecrets(withGroups(groups));
    expect(settings.groups).toEqual([]);
    expect(settings.resetGroups).toBe(true);
  });

  it.each([
    ['groups not a list', { g1: [0] }],
    ['an empty list', []],
    ['an unknown key', [{ ...two[0], color: 'red' }, two[1]]],
    ['a missing key', [{ id: 'g1', wallets: [0, 1, 2, 3] }]],
    ['wallets not a list', [{ id: 'g1', name: 'A', wallets: 0 }]],
    ['an index that is not a number', [{ id: 'g1', name: 'A', wallets: ['0', 1, 2, 3] }]],
    ['a name that is not text', [{ id: 'g1', name: 1, wallets: [0, 1, 2, 3] }]],
  ])('the shape stays strict: %s is an invalid file', (_name, groups) => {
    expect(codeOf(() => parseSecrets(withGroups(groups)))).toBe('KEYSTORE_INVALID_FORMAT');
  });
});
