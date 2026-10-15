/**
 * Direct buy route through Meteora DBC (BUNNDLY-48, D-062): the executor's second route
 * beside Jupiter, with the same contract (`JupiterClient`), so queue, limiter, mint gate,
 * attempts, STOP, Stairs and the chain check before a retry stay shared.
 *
 * - `getOrder`: the pool (from the watcher's detection, else `getProgramAccounts`), a quote
 *   with fees, the wallet's balance against amount + token account rent read from the chain
 *   + fees + reserve, a blockhash, and an unsigned v0 transaction paid by the wallet.
 * - `execute`: one `sendTransaction`, then the signature status until it is confirmed or
 *   its blockhash can no longer land. Never sent twice: an unclear outcome goes back to the
 *   executor, which checks the chain before any new attempt (D-030).
 * - `simulate`: DRY-RUN simulates the signed transaction; nothing is sent.
 * - Devnet only: before its first order the route checks the RPC's genesis hash and
 *   refuses any other network (mainnet stays on Jupiter until a separate test and the
 *   owner's consent, SPEC 2.2).
 *
 * Failures never carry the RPC URL (it may hold the Helius key) or the RPC's message.
 */
import {
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createSolanaRpcFromTransport,
  createTransactionMessage,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionDecoder,
  isSolanaError,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signature as toSignature,
  type Base64EncodedWireTransaction,
  type GetAccountInfoApi,
  type GetBalanceApi,
  type GetBlockHeightApi,
  type GetBlockTimeApi,
  type GetGenesisHashApi,
  type GetLatestBlockhashApi,
  type GetMinimumBalanceForRentExemptionApi,
  type GetProgramAccountsApi,
  type GetSignatureStatusesApi,
  type GetSlotApi,
  type GetTransactionApi,
  type Rpc,
  type RpcTransport,
  type SendTransactionApi,
  type SimulateTransactionApi,
} from '@solana/kit';
import { findAssociatedTokenAddress, TOKEN_ACCOUNT_SIZE } from '../chain/tokens.ts';
import { DEVNET_GENESIS_HASH } from '../core/network.ts';
import {
  SOL_MINT,
  type JupiterClient,
  type JupiterExecution,
  type JupiterFailure,
  type JupiterFailureCode,
  type JupiterOrder,
  type JupiterResult,
} from '../jupiter/client.ts';
import {
  buildBuyInstructions,
  fetchCurrentPoint,
  fetchDbcPool,
  fetchDbcPoolAt,
  quoteFromState,
  type DbcPoolState,
} from './meteora-dbc/index.ts';

export type DirectRpc = Rpc<
  GetAccountInfoApi &
    GetBalanceApi &
    GetBlockHeightApi &
    GetBlockTimeApi &
    GetGenesisHashApi &
    GetLatestBlockhashApi &
    GetMinimumBalanceForRentExemptionApi &
    GetProgramAccountsApi &
    GetSignatureStatusesApi &
    GetSlotApi &
    GetTransactionApi &
    SendTransactionApi &
    SimulateTransactionApi
>;

export function createDirectRpc(transport: RpcTransport): DirectRpc {
  return createSolanaRpcFromTransport(transport);
}

/** `router` of every direct order: the signer recognises the route by the network, not by it. */
export const DIRECT_ROUTER = 'meteora-dbc';

/**
 * Slippage when the wallet's setting is Auto (Jupiter picks it there; the curve has no
 * one to ask). The quote is read just before each wallet's send, so it covers the move
 * between the read and the landing, not the whole fleet's buying (D-062).
 */
export const DIRECT_AUTO_SLIPPAGE_BPS = 500;
/** A DBC buy uses about 100k compute units (devnet simulation in BUNNDLY-47). */
export const DIRECT_COMPUTE_UNIT_LIMIT = 200_000;
export const DIRECT_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS = 10_000n;
/** Base fee per signature, https://solana.com/docs/core/fees#base-fee */
export const LAMPORTS_PER_SIGNATURE = 5_000n;
/** Token-2022 accounts carry the ImmutableOwner extension: 165 + 1 type + 4 TLV header. */
export const TOKEN_2022_ACCOUNT_SIZE = 170;
export const CONFIRM_POLL_MS = 1_000;
/** No later than this, `execute` hands an unclear outcome to the executor's chain check. */
export const CONFIRM_TIMEOUT_MS = 90_000;

export interface PoolHint {
  readonly mint: string;
  readonly pool: string;
}

export interface DirectRouteOptions {
  readonly rpc: DirectRpc;
  /** Reserve the wallet keeps after the buy, its rent and fees (global setting). */
  readonly minReserveLamports: bigint;
  /** The pool from the watcher's detection (mode B); without it `getProgramAccounts`. */
  readonly poolHint?: PoolHint | null;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
  readonly confirmPollMs?: number;
  readonly confirmTimeoutMs?: number;
}

/** Where the run's pool came from: tests tell a detection from the fallback (BUNNDLY-48). */
export type PoolSource = 'detection' | 'program-accounts';

export interface DirectRoute extends JupiterClient {
  poolSource(mint: string): PoolSource | null;
}

interface Pending {
  readonly taker: string;
  readonly mint: string;
  readonly amount: bigint;
  readonly baseTokenProgram: DbcPoolState['baseTokenProgram'];
}

function failure(code: JupiterFailureCode, signature: string | null = null): JupiterFailure {
  return { ok: false, code, httpStatus: null, rateLimit: null, signature };
}

function ok<T>(value: T): JupiterResult<T> {
  return { ok: true, value, rateLimit: null };
}

/** The first signature of a wire transaction: its id, known before sending. */
export function firstSignature(wire: string): string | null {
  try {
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
    const first = Object.values(tx.signatures)[0];
    return first ? getBase58Decoder().decode(first) : null;
  } catch {
    return null;
  }
}

/** Raw token units of `mint` held by `owner` in a balance list from a transaction meta. */
function tokenUnits(
  balances: readonly { owner?: string; mint: string; uiTokenAmount: { amount: string } }[],
  owner: string,
  mint: string,
): bigint {
  return balances
    .filter((b) => b.owner === owner && b.mint === mint)
    .reduce((sum, b) => sum + BigInt(b.uiTokenAmount.amount), 0n);
}

export function createDirectRoute(options: DirectRouteOptions): DirectRoute {
  const { rpc } = options;
  const pollMs = options.confirmPollMs ?? CONFIRM_POLL_MS;
  const timeoutMs = options.confirmTimeoutMs ?? CONFIRM_TIMEOUT_MS;
  /** Pool address per mint, once found; its state is read again for every order. */
  const pools = new Map<string, { readonly address: string; readonly source: PoolSource }>();
  const pending = new Map<string, Pending>();
  let network: Promise<boolean> | null = null;
  let nextRequest = 1;

  const onDevnet = (): Promise<boolean> => {
    network ??= rpc
      .getGenesisHash()
      .send()
      .then((hash) => hash === DEVNET_GENESIS_HASH);
    // A failed read is asked again next time, never taken as an answer.
    network.catch(() => {
      network = null;
    });
    return network;
  };

  /** The pool of `mint` now, or why there is none. */
  const poolOf = async (
    mint: string,
  ): Promise<DbcPoolState | { readonly unsupported: string } | null> => {
    const known = pools.get(mint);
    if (known !== undefined) return fetchDbcPoolAt(rpc, known.address, mint);
    const hint = options.poolHint;
    if (hint !== undefined && hint !== null && hint.mint === mint) {
      const state = await fetchDbcPoolAt(rpc, hint.pool, mint);
      if (state !== null) {
        if ('address' in state) pools.set(mint, { address: state.address, source: 'detection' });
        return state;
      }
    }
    const state = await fetchDbcPool(rpc, mint);
    if (state !== null && 'address' in state) {
      pools.set(mint, { address: state.address, source: 'program-accounts' });
    }
    return state;
  };

  /** Lamports the buy needs besides the amount: a new token account's rent and the fees. */
  const costs = async (
    taker: string,
    state: DbcPoolState,
  ): Promise<{ readonly rent: bigint; readonly wsolRent: bigint; readonly fees: bigint }> => {
    const ata = await findAssociatedTokenAddress(
      taker,
      state.pool.baseMint,
      state.baseTokenProgram,
    );
    const existing = await rpc
      .getAccountInfo(address(ata), { encoding: 'base64', commitment: 'confirmed' })
      .send();
    const size =
      state.baseTokenProgram === 'token-2022' ? TOKEN_2022_ACCOUNT_SIZE : TOKEN_ACCOUNT_SIZE;
    const rent =
      existing.value === null
        ? await rpc.getMinimumBalanceForRentExemption(BigInt(size)).send()
        : 0n;
    // The wrapped SOL account is opened and closed in the same transaction: its rent
    // must be there while it runs and comes back at the end.
    const wsolRent = await rpc.getMinimumBalanceForRentExemption(BigInt(TOKEN_ACCOUNT_SIZE)).send();
    const priority =
      (BigInt(DIRECT_COMPUTE_UNIT_LIMIT) * DIRECT_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS + 999_999n) /
      1_000_000n;
    return { rent, wsolRent, fees: LAMPORTS_PER_SIGNATURE + priority };
  };

  const getOrder: JupiterClient['getOrder'] = async (request) => {
    // A sell through the curve is BUNNDLY-63.
    if (request.inputMint !== undefined || request.taker === undefined) {
      return failure('BAD_REQUEST');
    }
    if (request.amount <= 0n) return failure('BAD_REQUEST');
    const taker = request.taker;
    const mint = request.outputMint;
    try {
      if (!(await onDevnet())) return failure('WRONG_NETWORK');
      const state = await poolOf(mint);
      // No pool yet: a fresh token in mode B; the mint gate waits for it (D-035).
      if (state === null) return failure('NO_ROUTE');
      if (!('address' in state)) return failure('UNSUPPORTED_TOKEN');
      const point = await fetchCurrentPoint(rpc, state.config.activationType);
      const slippage = request.slippageBps ?? DIRECT_AUTO_SLIPPAGE_BPS;
      const quoted = quoteFromState(state, request.amount, slippage, point);
      switch (quoted.kind) {
        case 'ok':
          break;
        case 'not-active':
        case 'no-pool':
          return failure('NO_ROUTE');
        case 'graduated':
          return failure('GRADUATED');
        case 'insufficient-liquidity':
          return failure('INSUFFICIENT_LIQUIDITY');
        case 'unsupported-quote':
        case 'unsupported-token':
          return failure('UNSUPPORTED_TOKEN');
      }
      const base: Omit<JupiterOrder, 'transaction' | 'buildError' | 'lastValidBlockHeight'> = {
        requestId: `dbc-${String(nextRequest++)}`,
        router: DIRECT_ROUTER,
        inputMint: SOL_MINT,
        outputMint: mint,
        inAmount: request.amount,
        outAmount: quoted.quote.outputAmount,
        otherAmountThreshold: quoted.minimumAmountOut,
        taker,
        signatureFeePayer: taker,
        prioritizationFeePayer: taker,
        rentFeePayer: taker,
        gasless: false,
        expireAt: null,
        feeMint: null,
        feeBps: null,
        priceImpactPct: null,
      };
      const need = await costs(taker, state);
      const balance = (await rpc.getBalance(address(taker), { commitment: 'confirmed' }).send())
        .value;
      if (
        balance <
        request.amount + need.rent + need.wsolRent + need.fees + options.minReserveLamports
      ) {
        return ok({
          ...base,
          transaction: null,
          buildError: { errorCode: null, reason: 'INSUFFICIENT_FUNDS' },
          lastValidBlockHeight: null,
        });
      }
      const { value: latest } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
      const instructions = await buildBuyInstructions({
        payer: taker,
        pool: state.address,
        config: state.pool.config,
        baseMint: state.pool.baseMint,
        baseVault: state.pool.baseVault,
        quoteVault: state.pool.quoteVault,
        baseTokenProgram: state.baseTokenProgram,
        lamportsIn: request.amount,
        minimumAmountOut: quoted.minimumAmountOut,
        computeUnitLimit: DIRECT_COMPUTE_UNIT_LIMIT,
        computeUnitPriceMicroLamports: DIRECT_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS,
      });
      const message = pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayer(address(taker), m),
        (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
        (m) => appendTransactionMessageInstructions(instructions, m),
      );
      const transaction = getBase64EncodedWireTransaction(compileTransaction(message));
      pending.set(base.requestId, {
        taker,
        mint,
        amount: request.amount,
        baseTokenProgram: state.baseTokenProgram,
      });
      return ok({
        ...base,
        transaction,
        buildError: null,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      });
    } catch {
      // A read failed (RPC_UNAVAILABLE, a malformed account): nothing was sent.
      return failure('NETWORK');
    }
  };

  /** Tokens the wallet got, from the landed transaction's meta; null when not readable. */
  const received = async (sig: string, order: Pending): Promise<bigint | null> => {
    try {
      const tx = await rpc
        .getTransaction(toSignature(sig), {
          commitment: 'confirmed',
          encoding: 'json',
          maxSupportedTransactionVersion: 0,
        })
        .send();
      const meta = tx?.meta;
      if (!meta?.preTokenBalances || !meta.postTokenBalances) return null;
      return (
        tokenUnits(meta.postTokenBalances, order.taker, order.mint) -
        tokenUnits(meta.preTokenBalances, order.taker, order.mint)
      );
    } catch {
      return null;
    }
  };

  const execute: JupiterClient['execute'] = async (request) => {
    const order = pending.get(request.requestId);
    const sig = firstSignature(request.signedTransaction);
    if (order === undefined || sig === null) return failure('BAD_REQUEST');
    pending.delete(request.requestId);
    try {
      await rpc
        .sendTransaction(request.signedTransaction as Base64EncodedWireTransaction, {
          encoding: 'base64',
          preflightCommitment: 'confirmed',
        })
        .send();
    } catch (e) {
      // Preflight refused it: the RPC did not forward it, a new attempt is safe.
      if (
        isSolanaError(e, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE)
      ) {
        return failure('NOT_SENT', sig);
      }
      // No answer: it may be on its way. The executor checks the chain, never resends.
      return failure('NETWORK', sig);
    }
    const deadline = options.now() + timeoutMs;
    for (;;) {
      try {
        const { value } = await rpc.getSignatureStatuses([toSignature(sig)]).send();
        const status = value[0];
        if (
          status &&
          (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')
        ) {
          const landed: Omit<JupiterExecution, 'status' | 'code' | 'outcome'> = {
            signature: sig,
            slot: status.slot,
            totalInputAmount: order.amount,
            totalOutputAmount: null,
            inputAmountResult: null,
            outputAmountResult: null,
          };
          if (status.err !== null) {
            // On the chain with an error: the executor's chain check settles it as failed.
            return ok({
              ...landed,
              status: 'Failed',
              code: -1000,
              outcome: 'AGGREGATOR_FAILED_TO_LAND',
            });
          }
          const tokens = await received(sig, order);
          return ok({
            ...landed,
            totalOutputAmount: tokens,
            status: 'Success',
            code: 0,
            outcome: 'SUCCESS',
          });
        }
        if (request.lastValidBlockHeight !== undefined) {
          const height = await rpc.getBlockHeight({ commitment: 'confirmed' }).send();
          if (height > request.lastValidBlockHeight) return failure('TIMEOUT', sig);
        }
      } catch {
        // A read failed; the next poll asks again.
      }
      if (options.now() >= deadline) return failure('TIMEOUT', sig);
      await options.sleep(pollMs);
    }
  };

  const simulate: NonNullable<JupiterClient['simulate']> = async (signedTransaction) => {
    try {
      const { value } = await rpc
        .simulateTransaction(signedTransaction as Base64EncodedWireTransaction, {
          encoding: 'base64',
          commitment: 'confirmed',
          sigVerify: true,
        })
        .send();
      if (value.err !== null) {
        const problem = JSON.stringify(value.err, (_k, v: unknown) =>
          typeof v === 'bigint' ? String(v) : v,
        );
        return { ok: false, problem };
      }
      return { ok: true, unitsConsumed: value.unitsConsumed ?? null };
    } catch {
      return { ok: false, problem: 'RPC_UNAVAILABLE' };
    }
  };

  return {
    getOrder,
    execute,
    simulate,
    poolSource: (mint) => pools.get(mint)?.source ?? null,
  };
}
