/**
 * Checks before signing a direct DBC buy (BUNNDLY-48): the route's own transaction passes,
 * and each change a wrong or hostile build could make is refused before the key is used.
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
import {
  buildBuyInstructions,
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
