/**
 * Chain check over RPC (BUNNDLY-23, D-030): mock JSON-RPC transport, real transactions
 * built with @solana/kit, no network.
 */
import { base58 } from '@scure/base';
import type { RpcTransport } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import {
  BLOCK_TIME_MARGIN_MS,
  SIGNATURES_LIMIT,
  createLandingChecker,
  createLandingRpc,
} from '../../src/chain/index.ts';
import type { LandingQuery } from '../../src/executor/index.ts';
import { MAKER, buildTransaction } from '../helpers/tx-fakes.ts';

const TAKER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const OTHER = '3Mc6vR3S3rSgQDbe8JHkHHh6bQ1kQfmdJ5HfvTsWJrvA';
const NOW = 1_790_000_000_000;

const sig = (fill: number): Uint8Array => new Uint8Array(64).fill(fill);
const b58 = (bytes: Uint8Array): string => base58.encode(bytes);

/** The taker pays: its signature is the transaction id. */
const takerPays = buildTransaction({ feePayer: TAKER, preSigned: { [TAKER]: sig(1) } });
/** RFQ: the market maker pays and signs in /execute; the taker signed second. */
const rfqSent = buildTransaction({
  feePayer: MAKER,
  signers: [TAKER],
  preSigned: { [TAKER]: sig(2) },
});
const rfqLanded = buildTransaction({
  feePayer: MAKER,
  signers: [TAKER],
  preSigned: { [MAKER]: sig(3), [TAKER]: sig(2) },
});
const deposit = buildTransaction({
  feePayer: OTHER,
  signers: [TAKER],
  preSigned: { [OTHER]: sig(4), [TAKER]: sig(5) },
});

type Handler = (params: unknown[]) => unknown;

function rpcWith(handlers: Record<string, Handler>) {
  const calls: string[] = [];
  const transport = ((config: { payload: unknown }) => {
    const payload = config.payload as { id: unknown; method: string; params: unknown[] };
    calls.push(payload.method);
    const handler = handlers[payload.method];
    if (!handler) return Promise.reject(new Error(`unexpected ${payload.method}`));
    try {
      return Promise.resolve({ jsonrpc: '2.0', id: payload.id, result: handler(payload.params) });
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error('handler'));
    }
  }) as unknown as RpcTransport;
  const check = createLandingChecker(createLandingRpc(transport), { now: () => NOW });
  return { check, calls };
}

const aggregator = (signature: string | null = b58(sig(1))): LandingQuery => ({
  taker: TAKER,
  signedTransaction: takerPays,
  signature,
  lastValidBlockHeight: 1_000n,
  expireAt: null,
  sentAtMs: NOW - 10_000,
});

const rfq = (expireAt = Math.floor(NOW / 1000) - 5): LandingQuery => ({
  taker: TAKER,
  signedTransaction: rfqSent,
  signature: null,
  lastValidBlockHeight: null,
  expireAt,
  sentAtMs: NOW - 10_000,
});

const status = (s: Partial<{ err: unknown; confirmationStatus: string }> | null) => ({
  context: { slot: 2_000 },
  value: [
    s === null
      ? null
      : { slot: 1_500, confirmations: null, err: null, confirmationStatus: 'confirmed', ...s },
  ],
});

describe('known signature (taker pays)', () => {
  it('confirmed without error: landed, with slot; expiry is read first', async () => {
    const { check, calls } = rpcWith({
      getBlockHeight: () => 990,
      getSignatureStatuses: () => status({}),
    });
    expect(await check(aggregator())).toEqual({
      status: 'landed',
      signature: b58(sig(1)),
      slot: 1_500n,
    });
    expect(calls).toEqual(['getBlockHeight', 'getSignatureStatuses']);
  });

  it('the signature comes from the transaction when the query has none', async () => {
    const seen: unknown[] = [];
    const { check } = rpcWith({
      getBlockHeight: () => 990,
      getSignatureStatuses: (p) => {
        seen.push(p[0]);
        return status({ err: { InstructionError: [2, { Custom: 6001 }] } });
      },
    });
    expect(await check(aggregator(null))).toEqual({ status: 'failed', signature: b58(sig(1)) });
    expect(seen).toEqual([[b58(sig(1))]]);
  });

  it('only processed: pending', async () => {
    const { check } = rpcWith({
      getBlockHeight: () => 1_200,
      getSignatureStatuses: () => status({ confirmationStatus: 'processed' }),
    });
    expect(await check(aggregator())).toEqual({ status: 'pending' });
  });

  it('not found: pending up to lastValidBlockHeight, expired above it', async () => {
    for (const [height, expected] of [
      [999, 'pending'],
      [1_000, 'pending'],
      [1_001, 'expired'],
    ] as const) {
      const { check } = rpcWith({
        getBlockHeight: () => height,
        getSignatureStatuses: () => status(null),
      });
      expect((await check(aggregator())).status).toBe(expected);
    }
  });

  it('history is searched', async () => {
    let options: unknown;
    const { check } = rpcWith({
      getBlockHeight: () => 990,
      getSignatureStatuses: (p) => {
        options = p[1];
        return status(null);
      },
    });
    await check(aggregator());
    expect(options).toEqual({ searchTransactionHistory: true });
  });
});

describe('unknown signature (RFQ, gasless)', () => {
  const entry = (signature: string, blockTimeMs: number | null, err: unknown = null) => ({
    signature,
    slot: 1_600,
    err,
    memo: null,
    blockTime: blockTimeMs === null ? null : Math.floor(blockTimeMs / 1000),
    confirmationStatus: 'confirmed',
  });
  const txAnswer = (base64: string, err: unknown = null) => ({
    slot: 1_600,
    blockTime: Math.floor(NOW / 1000),
    transaction: [base64, 'base64'],
    meta: { err, fee: 5000 },
    version: 0,
  });

  it('found by the taker signature among the wallet transactions; a deposit is not ours', async () => {
    const fetched: unknown[] = [];
    const { check } = rpcWith({
      isBlockhashValid: () => ({ context: { slot: 1 }, value: true }),
      getSignaturesForAddress: () => [
        entry(b58(sig(4)), NOW - 2_000), // someone sent tokens to the taker
        entry(b58(sig(3)), NOW - 5_000), // our swap, id = the market maker's signature
        entry(b58(sig(9)), NOW - 10_000 - BLOCK_TIME_MARGIN_MS - 1_000), // before the send
      ],
      getTransaction: (p) => {
        fetched.push(p[0]);
        return p[0] === b58(sig(4)) ? txAnswer(deposit) : txAnswer(rfqLanded);
      },
    });
    expect(await check(rfq())).toEqual({ status: 'landed', signature: b58(sig(3)), slot: 1_600n });
    expect(fetched).toEqual([b58(sig(4)), b58(sig(3))]); // the old one is not fetched
  });

  it('landed with an error: failed', async () => {
    const { check } = rpcWith({
      isBlockhashValid: () => ({ context: { slot: 1 }, value: false }),
      getSignaturesForAddress: () => [entry(b58(sig(3)), NOW, { InstructionError: [1, {}] })],
      getTransaction: () => txAnswer(rfqLanded, { InstructionError: [1, {}] }),
    });
    expect(await check(rfq())).toEqual({ status: 'failed', signature: b58(sig(3)) });
  });

  it('not found: pending before expireAt (no blockhash call), then until the blockhash dies', async () => {
    const empty = { getSignaturesForAddress: () => [] };
    const early = rpcWith({ ...empty });
    expect(await early.check(rfq(Math.floor(NOW / 1000) + 10))).toEqual({ status: 'pending' });
    expect(early.calls).toEqual(['getSignaturesForAddress']);

    const valid = rpcWith({
      ...empty,
      isBlockhashValid: () => ({ context: { slot: 1 }, value: true }),
    });
    expect(await valid.check(rfq())).toEqual({ status: 'pending' });

    const dead = rpcWith({
      ...empty,
      isBlockhashValid: () => ({ context: { slot: 1 }, value: false }),
    });
    expect(await dead.check(rfq())).toEqual({ status: 'expired' });
    expect(dead.calls).toEqual(['isBlockhashValid', 'getSignaturesForAddress']);
  });

  it('a candidate not visible yet, or a full page of new entries: pending, even if expired', async () => {
    const hidden = rpcWith({
      isBlockhashValid: () => ({ context: { slot: 1 }, value: false }),
      getSignaturesForAddress: () => [entry(b58(sig(3)), NOW)],
      getTransaction: () => null,
    });
    expect(await hidden.check(rfq())).toEqual({ status: 'pending' });

    const full = rpcWith({
      isBlockhashValid: () => ({ context: { slot: 1 }, value: false }),
      getSignaturesForAddress: () =>
        Array.from({ length: SIGNATURES_LIMIT }, (_, i) => entry(b58(sig(100 + i)), NOW)),
      getTransaction: () => txAnswer(deposit),
    });
    expect(await full.check(rfq())).toEqual({ status: 'pending' });
  });

  it('asks only for the taker, at confirmed, with a limit', async () => {
    let params: unknown[] = [];
    const { check } = rpcWith({
      isBlockhashValid: () => ({ context: { slot: 1 }, value: true }),
      getSignaturesForAddress: (p) => {
        params = p;
        return [];
      },
    });
    await check(rfq());
    expect(params).toEqual([TAKER, { limit: SIGNATURES_LIMIT, commitment: 'confirmed' }]);
  });
});

describe('errors', () => {
  it('an RPC error rejects (the executor reads it as pending)', async () => {
    const { check } = rpcWith({});
    await expect(check(aggregator())).rejects.toThrow();
  });
});
