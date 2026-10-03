/**
 * Real pump.fun launches from mainnet (tests/fixtures/detectors.mainnet.json, D-037) for
 * the mode B tests: the `logsNotification` as Helius sent it and its transaction.
 */
import { readFileSync } from 'node:fs';

export interface LaunchNotification {
  /** The creator (signer of the create). */
  readonly watched: string;
  readonly expectedMint: string;
  /** The raw `logsNotification` message. */
  readonly message: {
    readonly params: {
      readonly result: { readonly value: { readonly signature: string } };
    };
  };
  /** `getTransaction` (json, v1) of the same signature. */
  readonly tx: unknown;
}

const F = JSON.parse(readFileSync('tests/fixtures/detectors.mainnet.json', 'utf8')) as {
  readonly notifications: readonly LaunchNotification[];
};

export function launch(i: number): LaunchNotification {
  const n = F.notifications[i];
  if (n === undefined) throw new Error(`no notification ${String(i)}`);
  return n;
}

export const signatureOf = (n: LaunchNotification): string =>
  n.message.params.result.value.signature;

/** The same transaction with another block time (Unix s). */
export function withBlockTime(tx: unknown, blockTime: number): unknown {
  return { ...(tx as Record<string, unknown>), blockTime };
}

/**
 * The same transaction creating another mint: every occurrence of `from` replaced by
 * `to` (account keys and token balances). For a second launch by the same creator.
 */
export function withMint(tx: unknown, from: string, to: string): unknown {
  return JSON.parse(JSON.stringify(tx).replaceAll(from, to)) as unknown;
}
