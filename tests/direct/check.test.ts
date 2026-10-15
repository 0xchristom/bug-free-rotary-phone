/**
 * Checks before signing a direct DBC buy (BUNNDLY-48) or sell (BUNNDLY-63): the route's own
 * transaction passes, and each change a wrong or hostile build could make is refused before
 * the key is used.
 */
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Instruction,
} from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { deriveWallets } from '../../src/core/index.ts';
import { checkDirectTransaction } from '../../src/direct/check.ts';
import { findAssociatedTokenAddress } from '../../src/chain/tokens.ts';
import {
  WSOL_MINT,
  buildBuyInstructions,
  buildSellInstructions,
  setComputeUnitLimit,
  setComputeUnitPrice,
  transferSol,
} from '../../src/direct/meteora-dbc/index.ts';
import { SOL_MINT, type JupiterOrder } from '../../src/jupiter/client.ts';
import { CASE } from '../helpers/direct-rpc.ts';

const wallets = deriveWallets(`${'abandon '.repeat(11)}about`, 0, 2);
const TAKER = wallets[0]?.address ?? '';
const OTHER = wallets[1]?.address ?? '';
const AMOUNT = 2_000_000n;

const buy = (payer = TAKER, lamportsIn = AMOUNT) =>
  buildBuyInstructions({
    payer,
    pool: CASE.pool,
    config: CASE.config,
    baseMint: CASE.baseMint,
    baseVault: 'F34SBRP4ib2Y5xqpXbiS8y6nUGoAEtBu4aJ3NTjUbP6Y',
    quoteVault: '5DERoUkdGNVxZYNQwCxgPjj2dFWedECrvwZQPMAv83Sb',
    baseTokenProgram: 'spl-token',
    lamportsIn,
    minimumAmountOut: 1_000n,
    computeUnitLimit: 200_000,
    computeUnitPriceMicroLamports: 10_000n,
  });

function wire(instructions: readonly Instruction[], feePayer = TAKER): string {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(feePayer), m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: blockhash('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
          lastValidBlockHeight: 1n,
        },
        m,
      ),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  return getBase64EncodedWireTransaction(compileTransaction(message));
}

function orderOf(transaction: string, overrides: Partial<JupiterOrder> = {}): JupiterOrder {
  return {
    requestId: 'dbc-1',
    router: 'meteora-dbc',
    inputMint: SOL_MINT,
    outputMint: CASE.baseMint,
    inAmount: AMOUNT,
    outAmount: 2_000n,
    otherAmountThreshold: 1_000n,
    transaction,
    buildError: null,
    taker: TAKER,
    signatureFeePayer: TAKER,
    prioritizationFeePayer: TAKER,
    rentFeePayer: TAKER,
    gasless: false,
    lastValidBlockHeight: 1n,
    expireAt: null,
    feeMint: null,
    feeBps: null,
    priceImpactPct: null,
    ...overrides,
  };
}

const expected = { taker: TAKER, outputMint: CASE.baseMint, amount: AMOUNT, maxSpend: AMOUNT };

async function problemOf(instructions: readonly Instruction[], feePayer = TAKER) {
  const result = await checkDirectTransaction(orderOf(wire(instructions, feePayer)), expected);
  return result.ok ? 'ok' : result.problem;
}

describe('checkDirectTransaction', () => {
  it('passes the buy the route builds, taker pays the fee', async () => {
    const result = await checkDirectTransaction(orderOf(wire(await buy())), expected);
    expect(result.ok && result.checked.takerPaysFee).toBe(true);
  });

  it('refuses an order above max spend or for another amount', async () => {
    const tx = wire(await buy());
    const over = await checkDirectTransaction(orderOf(tx), { ...expected, maxSpend: AMOUNT - 1n });
    expect(over.ok ? 'ok' : over.problem).toBe('OVER_MAX_SPEND');
    // The order says 2 000 000, the instructions move 3 000 000 (the transfer comes first).
    expect(await problemOf(await buy(TAKER, 3_000_000n))).toBe('TRANSFER_MISMATCH');
    // Only `swap2` spends more than ordered.
    const ixs = await buy();
    const swap = ixs[6];
    if (swap?.data === undefined) throw new Error('fixture');
    const data = Uint8Array.from(swap.data);
    new DataView(data.buffer).setBigUint64(8, 3_000_000n, true);
    expect(await problemOf([...ixs.slice(0, 6), { ...swap, data }, ...ixs.slice(7)])).toBe(
      'AMOUNT_MISMATCH',
    );
  });

  it('refuses another fee payer and a second signer', async () => {
    expect(await problemOf(await buy(), OTHER)).toBe('SIGNER_MISMATCH');
    const extra: Instruction = {
      programAddress: address('11111111111111111111111111111111'),
      accounts: [{ address: address(OTHER), role: AccountRole.WRITABLE_SIGNER }],
      data: new Uint8Array([2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0]),
    };
    expect(await problemOf([...(await buy()), extra])).toBe('SIGNER_MISMATCH');
  });

  it('refuses a program outside the DBC buy', async () => {
    const memo: Instruction = {
      programAddress: address('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'),
      data: new Uint8Array([1]),
    };
    expect(await problemOf([...(await buy()), memo])).toBe('PROGRAM_NOT_ALLOWED');
  });

  it('refuses a second SOL transfer, also to another address', async () => {
    expect(await problemOf([...(await buy()), transferSol(TAKER, OTHER, 1n)])).toBe(
      'TRANSFER_MISMATCH',
    );
  });

  it('refuses a buy of another token or for another wallet', async () => {
    const tx = wire(await buy());
    const other = await checkDirectTransaction(orderOf(tx, { outputMint: CASE.config }), {
      ...expected,
      outputMint: CASE.config,
    });
    expect(other.ok ? 'ok' : other.problem).toBe('SWAP_MISMATCH');
    expect(await problemOf(await buy(OTHER), OTHER)).toBe('SIGNER_MISMATCH');
  });

  it('refuses a priority fee above 0.001 SOL', async () => {
    const ixs = await buy();
    // 1 400 000 units × 1 000 000 µlamports = 1.4 SOL of priority fee.
    const greedy = [
      setComputeUnitLimit(1_400_000),
      setComputeUnitPrice(1_000_000n),
      ...ixs.slice(2),
    ];
    expect(await problemOf(greedy)).toBe('PRIORITY_FEE_TOO_HIGH');
    // Exactly 0.001 SOL passes: 200 000 × 5 000 000 / 10^6 = 1 000 000 lamports.
    const edge = [setComputeUnitLimit(200_000), setComputeUnitPrice(5_000_000n), ...ixs.slice(2)];
    expect(await problemOf(edge)).toBe('ok');
  });

  it('refuses closing the wrapped SOL account to someone else', async () => {
    const ixs = await buy();
    const close = ixs[ixs.length - 1];
    if (close === undefined) throw new Error('fixture');
    const accounts = [...(close.accounts ?? [])];
    const destination = accounts[1];
    if (destination === undefined) throw new Error('fixture');
    accounts[1] = { ...destination, address: address(OTHER) };
    expect(await problemOf([...ixs.slice(0, -1), { ...close, accounts }])).toBe(
      'TRANSFER_MISMATCH',
    );
  });

  it('refuses a buy whose tokens go to another wallet’s token account', async () => {
    const ixs = await buy();
    const swap = ixs[6];
    if (swap === undefined) throw new Error('fixture');
    const accounts = [...(swap.accounts ?? [])];
    const output = accounts[4];
    if (output === undefined) throw new Error('fixture');
    const theirs = await findAssociatedTokenAddress(OTHER, CASE.baseMint, 'spl-token');
    accounts[4] = { ...output, address: address(theirs) };
    expect(await problemOf([...ixs.slice(0, 6), { ...swap, accounts }, ...ixs.slice(7)])).toBe(
      'SWAP_MISMATCH',
    );
  });

  it('refuses a minimum out other than the order’s (the slippage limit)', async () => {
    const tx = wire(await buy()); // minimum 1 000 in the swap2
    const result = await checkDirectTransaction(
      orderOf(tx, { otherAmountThreshold: 1_001n }),
      expected,
    );
    expect(result.ok ? 'ok' : result.problem).toBe('MINIMUM_OUT_MISMATCH');
  });

  it('refuses a transaction without a minimum out', async () => {
    const ixs = await buy();
    const swap = ixs[6];
    if (swap?.data === undefined) throw new Error('fixture');
    const data = Uint8Array.from(swap.data);
    data.fill(0, 16, 24);
    const zeroMin = [...ixs.slice(0, 6), { ...swap, data }, ...ixs.slice(7)];
    expect(await problemOf(zeroMin)).toBe('NO_MINIMUM_OUT');
  });
});

describe('checkDirectTransaction, sell (BUNNDLY-63)', () => {
  const TOKENS = 9_810_963_807_547n;
  const MIN = 9_647_348n;
  const sell = (payer = TAKER, amountIn = TOKENS, minimumAmountOut = MIN) =>
    buildSellInstructions({
      payer,
      pool: CASE.pool,
      config: CASE.config,
      baseMint: CASE.baseMint,
      baseVault: 'F34SBRP4ib2Y5xqpXbiS8y6nUGoAEtBu4aJ3NTjUbP6Y',
      quoteVault: '5DERoUkdGNVxZYNQwCxgPjj2dFWedECrvwZQPMAv83Sb',
      baseTokenProgram: 'spl-token',
      amountIn,
      minimumAmountOut,
      computeUnitLimit: 200_000,
      computeUnitPriceMicroLamports: 10_000n,
    });
  const sellOrder = (transaction: string, overrides: Partial<JupiterOrder> = {}) =>
    orderOf(transaction, {
      inputMint: CASE.baseMint,
      outputMint: SOL_MINT,
      inAmount: TOKENS,
      outAmount: 10_155_104n,
      otherAmountThreshold: MIN,
      ...overrides,
    });
  const sellExpected = {
    taker: TAKER,
    inputMint: CASE.baseMint,
    outputMint: SOL_MINT,
    amount: TOKENS,
    maxSpend: TOKENS,
  };
  async function sellProblem(instructions: readonly Instruction[], feePayer = TAKER) {
    const result = await checkDirectTransaction(
      sellOrder(wire(instructions, feePayer)),
      sellExpected,
    );
    return result.ok ? 'ok' : result.problem;
  }
  /** The sell's swap2 (compute ×2, wrapped SOL account, swap2, close). */
  async function withSwap(change: (swap: Instruction) => Instruction) {
    const ixs = await sell();
    const swap = ixs[3];
    if (swap === undefined) throw new Error('fixture');
    return [...ixs.slice(0, 3), change(swap), ...ixs.slice(4)];
  }
  const swapAccount = (n: number, to: string) => (swap: Instruction) => {
    const accounts = [...(swap.accounts ?? [])];
    const at = accounts[n];
    if (at === undefined) throw new Error('fixture');
    accounts[n] = { ...at, address: address(to) };
    return { ...swap, accounts };
  };

  it('passes the sell the route builds: no System transfer, taker pays the fee', async () => {
    const result = await checkDirectTransaction(sellOrder(wire(await sell())), sellExpected);
    expect(result.ok && result.checked.takerPaysFee).toBe(true);
  });

  it('refuses more tokens than the sell plan, and another amount in the swap2', async () => {
    const tx = wire(await sell());
    const over = await checkDirectTransaction(sellOrder(tx), {
      ...sellExpected,
      maxSpend: TOKENS - 1n,
    });
    expect(over.ok ? 'ok' : over.problem).toBe('OVER_MAX_SPEND');
    const more = await checkDirectTransaction(sellOrder(wire(await sell(TAKER, TOKENS + 1n))), {
      ...sellExpected,
    });
    expect(more.ok ? 'ok' : more.problem).toBe('AMOUNT_MISMATCH');
  });

  it('refuses SOL paid out to another wallet’s wrapped SOL account', async () => {
    const theirs = await findAssociatedTokenAddress(OTHER, WSOL_MINT, 'spl-token');
    expect(await sellProblem(await withSwap(swapAccount(4, theirs)))).toBe('SWAP_MISMATCH');
  });

  it('refuses tokens taken from another token account', async () => {
    const theirs = await findAssociatedTokenAddress(OTHER, CASE.baseMint, 'spl-token');
    expect(await sellProblem(await withSwap(swapAccount(3, theirs)))).toBe('SWAP_MISMATCH');
  });

  it('refuses any System transfer in a sell', async () => {
    expect(await sellProblem([...(await sell()), transferSol(TAKER, OTHER, 1n)])).toBe(
      'TRANSFER_MISMATCH',
    );
  });

  it('refuses a minimum other than the order’s, and no minimum at all', async () => {
    expect(await sellProblem(await sell(TAKER, TOKENS, MIN - 1n))).toBe('MINIMUM_OUT_MISMATCH');
    const zero = await withSwap((swap) => {
      const data = Uint8Array.from(swap.data ?? []);
      data.fill(0, 16, 24);
      return { ...swap, data };
    });
    expect(await sellProblem(zero)).toBe('NO_MINIMUM_OUT');
  });

  it('refuses a sell for anything but SOL, and a buy signed as a sell', async () => {
    const tx = wire(await sell());
    const notSol = await checkDirectTransaction(sellOrder(tx, { outputMint: CASE.config }), {
      ...sellExpected,
      outputMint: CASE.config,
    });
    expect(notSol.ok ? 'ok' : notSol.problem).toBe('OUTPUT_MINT_MISMATCH');
    // The order says SOL in: it is a buy, whatever the instructions are.
    const asBuy = await checkDirectTransaction(
      sellOrder(tx, { inputMint: SOL_MINT }),
      sellExpected,
    );
    expect(asBuy.ok ? 'ok' : asBuy.problem).toBe('INPUT_MINT_MISMATCH');
    // A buy's transaction under a sell plan: no swap of the wallet's tokens into SOL.
    const buyTx = await checkDirectTransaction(sellOrder(wire(await buy())), sellExpected);
    expect(buyTx.ok).toBe(false);
  });

  it('refuses another fee payer', async () => {
    expect(await sellProblem(await sell(), OTHER)).toBe('SIGNER_MISMATCH');
  });
});
