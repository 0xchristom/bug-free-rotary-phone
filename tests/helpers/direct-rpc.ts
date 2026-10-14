/**
 * A fake devnet RPC for the direct Meteora DBC route (BUNNDLY-48), serving the real pool,
 * config and mint of a captured devnet buy (tests/fixtures/meteora-dbc.devnet.json). Every
 * call is counted by method; tests change the answers through `chain`.
 */
import {
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SolanaError,
} from '@solana/kit';
import { DEVNET_GENESIS_HASH } from '../../src/core/network.ts';
import { DBC_PROGRAM_ADDRESS } from '../../src/direct/meteora-dbc/index.ts';
import { firstSignature, type DirectRpc } from '../../src/direct/route.ts';
import devnet from '../fixtures/meteora-dbc.devnet.json';

export const CASE = devnet.cases[0] as (typeof devnet.cases)[number];
/** Lamports the captured buy put into the curve (its `swap2` amount_0). */
export const CASE_LAMPORTS = 2_000_000n;
/** Tokens the captured buyer got: post − pre balance in the transaction meta. */
export const CASE_TOKENS = 3_570_451_702_257n - 1_794_848_238_309n;
/** Real rent of a 165-byte account (getMinimumBalanceForRentExemption on devnet). */
export const RENT_165 = 2_039_280n;

export interface FakeChain {
  genesis: string;
  /** Lamports of every address asked about. */
  balance: bigint;
  /** Rent the RPC answers for any size; null: the real value for 165 bytes. */
  rent: bigint | null;
  /** The wallet's token account exists (no rent to pay). */
  tokenAccountExists: boolean;
  /** `sendTransaction`: 'ok', refused in preflight, or accepted and the answer lost. */
  send: 'ok' | 'preflight' | 'lost';
  /** The transaction landed (status confirmed), with or without an error. */
  landed: 'ok' | 'error' | 'no';
  blockHeight: bigint;
  simulateError: unknown;
  /** Tokens the landed transaction moved into `taker`. */
  received: bigint;
}

export interface FakeDirectRpc {
  readonly rpc: DirectRpc;
  readonly chain: FakeChain;
  readonly calls: Map<string, number>;
  /** Wire transactions given to sendTransaction, in order. */
  readonly sent: string[];
  count(method: string): number;
}

const account = (data: string, owner: string) => ({
  value: { data: [data, 'base64'], owner, lamports: 1n, executable: false, rentEpoch: 0n },
});

export function fakeDirectRpc(taker: string, overrides: Partial<FakeChain> = {}): FakeDirectRpc {
  const chain: FakeChain = {
    genesis: DEVNET_GENESIS_HASH,
    balance: 1_000_000_000n,
    rent: null,
    tokenAccountExists: false,
    send: 'ok',
    landed: 'ok',
    blockHeight: 100n,
    simulateError: null,
    received: CASE_TOKENS,
    ...overrides,
  };
  const calls = new Map<string, number>();
  const sent: string[] = [];
  const answer =
    (method: string, value: (...args: unknown[]) => unknown) =>
    (...args: unknown[]) => ({
      send: () => {
        calls.set(method, (calls.get(method) ?? 0) + 1);
        try {
          return Promise.resolve(value(...args));
        } catch (e) {
          return Promise.reject(e instanceof Error ? e : new Error(String(e)));
        }
      },
    });
  const accounts: Record<string, unknown> = {
    [CASE.pool]: account(CASE.poolData, DBC_PROGRAM_ADDRESS),
    [CASE.config]: account(CASE.configData, DBC_PROGRAM_ADDRESS),
    [CASE.baseMint]: account(CASE.baseMintData, CASE.baseMintOwner),
  };
  const fake = {
    getGenesisHash: answer('getGenesisHash', () => chain.genesis),
    getProgramAccounts: answer('getProgramAccounts', () => [
      { pubkey: CASE.pool, account: account(CASE.poolData, DBC_PROGRAM_ADDRESS).value },
    ]),
    getAccountInfo: answer('getAccountInfo', (who) => {
      const known = accounts[String(who)];
      if (known !== undefined) return known;
      // Any other address is the wallet's token account (or the wrapped SOL one).
      return chain.tokenAccountExists
        ? account('', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
        : { value: null };
    }),
    getSlot: answer('getSlot', () => BigInt(CASE.poolReadSlot)),
    getBlockTime: answer('getBlockTime', () => BigInt(CASE.blockTime)),
    getMinimumBalanceForRentExemption: answer(
      'getMinimumBalanceForRentExemption',
      () => chain.rent ?? RENT_165,
    ),
    getBalance: answer('getBalance', () => ({ value: chain.balance })),
    getLatestBlockhash: answer('getLatestBlockhash', () => ({
      value: {
        blockhash: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        lastValidBlockHeight: 150n,
      },
    })),
    getBlockHeight: answer('getBlockHeight', () => chain.blockHeight),
    sendTransaction: answer('sendTransaction', (wire) => {
      sent.push(String(wire));
      if (chain.send === 'preflight') {
        throw new SolanaError(
          SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
          {
            accounts: null,
            err: 'BlockhashNotFound',
            logs: null,
            unitsConsumed: 0n,
            returnData: null,
          } as never,
        );
      }
      if (chain.send === 'lost') throw new TypeError('fetch failed');
      return firstSignature(String(wire));
    }),
    getSignatureStatuses: answer('getSignatureStatuses', () => ({
      value: [
        chain.landed === 'no' || sent.length === 0
          ? null
          : {
              slot: BigInt(CASE.slot),
              confirmations: null,
              confirmationStatus: 'confirmed',
              err: chain.landed === 'error' ? { InstructionError: [4, { Custom: 6001 }] } : null,
            },
      ],
    })),
    getTransaction: answer('getTransaction', () => ({
      meta: {
        preTokenBalances: [{ owner: taker, mint: CASE.baseMint, uiTokenAmount: { amount: '0' } }],
        postTokenBalances: [
          { owner: taker, mint: CASE.baseMint, uiTokenAmount: { amount: String(chain.received) } },
        ],
      },
    })),
    simulateTransaction: answer('simulateTransaction', () => ({
      value: { err: chain.simulateError, unitsConsumed: 61_000n },
    })),
  };
  return {
    rpc: fake as unknown as DirectRpc,
    chain,
    calls,
    sent,
    count: (method) => calls.get(method) ?? 0,
  };
}
