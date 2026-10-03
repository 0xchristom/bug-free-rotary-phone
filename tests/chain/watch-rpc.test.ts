/**
 * RPC reads of mode B (BUNNDLY-34, D-038): exactly the parameters the detectors and the
 * catch-up rely on. Mock transport, no network.
 */
import type { RpcTransport } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { createWatchRpc, signatureReader, transactionReader } from '../../src/chain/index.ts';

const CREATOR = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const SIG_A = '5'.repeat(87) + '1';
const SIG_B = '4'.repeat(87) + '1';

function setup(result: unknown) {
  const payloads: { method: string; params: unknown[] }[] = [];
  const transport = ((config: { payload: unknown }) => {
    const payload = config.payload as { id: unknown; method: string; params: unknown[] };
    payloads.push({ method: payload.method, params: payload.params });
    return Promise.resolve({ jsonrpc: '2.0', id: payload.id, result });
  }) as unknown as RpcTransport;
  return { rpc: createWatchRpc(transport), payloads };
}

describe('watch RPC', () => {
  it('getTransaction: json, confirmed, maxSupportedTransactionVersion 1', async () => {
    const { rpc, payloads } = setup(null);
    expect(await transactionReader(rpc)(SIG_A)).toBeNull();
    expect(payloads).toEqual([
      {
        method: 'getTransaction',
        params: [
          SIG_A,
          { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 1 },
        ],
      },
    ]);
  });

  it('getSignaturesForAddress: confirmed, until and before passed on; block time kept', async () => {
    const { rpc, payloads } = setup([
      { signature: SIG_B, slot: 1n, err: null, memo: null, blockTime: 1_790_000_000n },
    ]);
    const list = await signatureReader(rpc, CREATOR)({ limit: 1000, until: SIG_A, before: SIG_B });
    expect(payloads[0]).toEqual({
      method: 'getSignaturesForAddress',
      params: [CREATOR, { limit: 1000, commitment: 'confirmed', until: SIG_A, before: SIG_B }],
    });
    expect(list).toEqual([{ signature: SIG_B, err: null, blockTime: 1_790_000_000n }]);
  });
});
