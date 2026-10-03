/**
 * Slow path (BUNNDLY-33, D-037): the new mint from the full transaction
 * (`getTransaction`, `encoding: "json"`, `confirmed`, `maxSupportedTransactionVersion: 1`).
 *
 * Every instruction counts, also inner ones (CPI): launchpad instructions from their IDLs
 * first, then the generic fallback `InitializeMint` / `InitializeMint2` of SPL Token or
 * Token-2022. A detection needs the watched address to be a signer of the transaction;
 * a failed transaction gives none.
 */
import { base58 } from '@scure/base';
import {
  INITIALIZE_MINT_TAGS,
  KNOWN_MINTS,
  MINT_INSTRUCTIONS,
  TOKEN_PROGRAMS,
  type DetectionSource,
} from './programs.ts';

interface JsonInstruction {
  readonly programIdIndex: number;
  readonly accounts: readonly number[];
  readonly data: string;
}

/** The parts of a `getTransaction` (json) answer the detectors read. Validated at runtime. */
export interface TransactionJson {
  readonly slot: number | bigint;
  /** Unix seconds; null or missing when the node does not know it. */
  readonly blockTime?: number | bigint | null;
  readonly transaction: {
    readonly message: {
      readonly accountKeys: readonly string[];
      readonly header: { readonly numRequiredSignatures: number };
      readonly instructions: readonly JsonInstruction[];
    };
  };
  readonly meta: {
    readonly err: unknown;
    readonly innerInstructions?:
      readonly { readonly instructions: readonly JsonInstruction[] }[] | null;
    readonly loadedAddresses?: {
      readonly writable: readonly string[];
      readonly readonly: readonly string[];
    } | null;
  } | null;
}

export interface TransactionDetection {
  readonly mint: string;
  readonly source: DetectionSource;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function isInstruction(v: unknown): v is JsonInstruction {
  return (
    isRecord(v) &&
    typeof v.programIdIndex === 'number' &&
    Array.isArray(v.accounts) &&
    v.accounts.every((a) => typeof a === 'number') &&
    typeof v.data === 'string'
  );
}

/** Narrows an RPC answer to `TransactionJson`, or null when it does not have that shape. */
export function asTransaction(value: unknown): TransactionJson | null {
  if (!isRecord(value) || !isRecord(value.transaction)) return null;
  const message = value.transaction.message;
  if (!isRecord(message) || !isRecord(message.header)) return null;
  if (
    !Array.isArray(message.accountKeys) ||
    !message.accountKeys.every((k) => typeof k === 'string')
  ) {
    return null;
  }
  if (typeof message.header.numRequiredSignatures !== 'number') return null;
  if (!Array.isArray(message.instructions) || !message.instructions.every(isInstruction))
    return null;
  if (value.meta !== null && !isRecord(value.meta)) return null;
  if (typeof value.slot !== 'number' && typeof value.slot !== 'bigint') return null;
  return value as unknown as TransactionJson;
}

interface Instruction {
  readonly program: string;
  readonly accounts: readonly string[];
  readonly data: Uint8Array;
}

/** Top-level and inner instructions with resolved addresses (static + lookup tables). */
function instructions(tx: TransactionJson): Instruction[] {
  const { message } = tx.transaction;
  const loaded = tx.meta?.loadedAddresses;
  const keys = [...message.accountKeys, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])];
  const inner = (tx.meta?.innerInstructions ?? []).flatMap((group) =>
    group.instructions.filter(isInstruction),
  );
  const out: Instruction[] = [];
  for (const ix of [...message.instructions, ...inner]) {
    const program = keys[ix.programIdIndex];
    if (program === undefined) continue;
    let data: Uint8Array;
    try {
      data = base58.decode(ix.data);
    } catch {
      continue;
    }
    out.push({
      program,
      accounts: ix.accounts.map((a) => keys[a] ?? ''),
      data,
    });
  }
  return out;
}

/** Signers: the first `numRequiredSignatures` static keys. */
export function signers(tx: TransactionJson): string[] {
  const { accountKeys, header } = tx.transaction.message;
  return accountKeys.slice(0, header.numRequiredSignatures);
}

function startsWith(data: Uint8Array, prefix: readonly number[]): boolean {
  return data.length >= prefix.length && prefix.every((b, i) => data[i] === b);
}

/** New mints created by the watched address in this transaction. Never throws. */
export function detectFromTransaction(
  tx: TransactionJson,
  watched: string,
): TransactionDetection[] {
  if (tx.meta === null || tx.meta.err !== null) return [];
  if (!signers(tx).includes(watched)) return [];
  const launchpad: TransactionDetection[] = [];
  const generic: TransactionDetection[] = [];
  for (const ix of instructions(tx)) {
    const known = MINT_INSTRUCTIONS.find(
      (m) => m.program === ix.program && startsWith(ix.data, m.discriminator),
    );
    if (known) {
      const mint = ix.accounts[known.mintAccount];
      if (mint) launchpad.push({ mint, source: known.source });
      continue;
    }
    const tag = ix.data[0];
    if (TOKEN_PROGRAMS.has(ix.program) && tag !== undefined && INITIALIZE_MINT_TAGS.has(tag)) {
      const mint = ix.accounts[0];
      if (mint) generic.push({ mint, source: 'initialize-mint' });
    }
  }
  // A launchpad names its mint; the generic fallback adds only mints no launchpad named.
  const found: TransactionDetection[] = [];
  for (const d of [...launchpad, ...generic]) {
    if (KNOWN_MINTS.has(d.mint) || found.some((f) => f.mint === d.mint)) continue;
    found.push(d);
  }
  return found;
}
