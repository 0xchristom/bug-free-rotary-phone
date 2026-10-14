/**
 * The direct Meteora DBC route (BUNNDLY-48) over a fake devnet RPC that serves a real
 * captured devnet buy. Expected numbers come from that capture (tokens from the meta's
 * balances) or are added up by hand here, never from the route itself.
 */
import {
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
} from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { deriveWallets } from '../../src/core/index.ts';
import { checkDirectTransaction } from '../../src/direct/check.ts';
import { createDirectRoute, DIRECT_ROUTER, type PoolHint } from '../../src/direct/route.ts';
import type { JupiterOrder } from '../../src/jupiter/client.ts';
import { signCheckedOrder } from '../../src/worker/sign-order.ts';
import {
  CASE,
  CASE_LAMPORTS,
  CASE_TOKENS,
  RENT_165,
  fakeDirectRpc,
  type FakeChain,
} from '../helpers/direct-rpc.ts';

const [derived] = deriveWallets(`${'abandon '.repeat(11)}about`, 0, 1);
if (derived === undefined) throw new Error('fixture');
const wallet = derived;
const TAKER = wallet.address;
const RESERVE = 10_000_000n;
/** 5 000 per signature + ceil(200 000 units × 10 000 µlamports / 10^6) = 2 000. */
const FEES = 7_000n;

function setup(overrides: Partial<FakeChain> = {}, poolHint: PoolHint | null = null) {
  const fake = fakeDirectRpc(TAKER, overrides);
  let t = 0;
  const route = createDirectRoute({
    rpc: fake.rpc,
    minReserveLamports: RESERVE,
    poolHint,
    now: () => t,
    sleep: (ms) => {
      t += ms;
      return Promise.resolve();
    },
  });
  return { fake, route };
}

async function order(route: ReturnType<typeof setup>['route'], amount = CASE_LAMPORTS) {
  const answer = await route.getOrder({ outputMint: CASE.baseMint, amount, taker: TAKER });
  if (!answer.ok) throw new Error(answer.code);
  return answer.value;
}

async function sign(o: JupiterOrder): Promise<string> {
  const check = await checkDirectTransaction(o, {
    taker: TAKER,
    outputMint: CASE.baseMint,
    amount: o.inAmount,
    maxSpend: o.inAmount,
  });
  if (!check.ok) throw new Error(check.problem);
  return (await signCheckedOrder(wallet.secretKey, check.checked)).signedTransaction;
}

describe('getOrder', () => {
  it('quotes the captured buy: the tokens the buyer really got, and a minimum 5% below', async () => {
    const { route } = setup();
    const o = await order(route);
    expect(o.router).toBe(DIRECT_ROUTER);
    expect(o.inAmount).toBe(2_000_000n);
    expect(o.outAmount).toBe(CASE_TOKENS);
    // Auto slippage is 500 bps: floor(out × 9 500 / 10 000).
    expect(o.otherAmountThreshold).toBe((CASE_TOKENS * 9_500n) / 10_000n);
    expect(o.taker).toBe(TAKER);
    expect(o.signatureFeePayer).toBe(TAKER);
    expect(o.lastValidBlockHeight).toBe(150n);
    // A v0 transaction with the wallet as the only signer and fee payer.
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(o.transaction ?? ''));
    const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    expect(message.version).toBe(0);
    expect(message.staticAccounts[0]).toBe(TAKER);
    expect(message.header.numSignerAccounts).toBe(1);
  });

  it('the wallet slippage, when set, replaces the Auto 5%', async () => {
    const { route } = setup();
    const answer = await route.getOrder({
      outputMint: CASE.baseMint,
      amount: CASE_LAMPORTS,
      taker: TAKER,
      slippageBps: 100,
    });
    expect(answer.ok && answer.value.otherAmountThreshold).toBe((CASE_TOKENS * 9_900n) / 10_000n);
  });

  it('balance = amount + token account rent + wrapped SOL rent + fees + reserve builds; 1 lamport less does not', async () => {
    const need = CASE_LAMPORTS + RENT_165 + RENT_165 + FEES + RESERVE; // 16 085 560
    expect(need).toBe(16_085_560n);
    const enough = await order(setup({ balance: need }).route);
    expect(enough.transaction).not.toBeNull();
    const short = await order(setup({ balance: need - 1n }).route);
    expect(short.transaction).toBeNull();
    expect(short.buildError?.reason).toBe('INSUFFICIENT_FUNDS');
  });

  it('the rent comes from the chain: a higher rent than the usual 2 039 280 refuses the same balance', async () => {
    const usual = CASE_LAMPORTS + RENT_165 + RENT_165 + FEES + RESERVE;
    const { route, fake } = setup({ balance: usual, rent: 2_500_000n });
    const o = await order(route);
    expect(o.buildError?.reason).toBe('INSUFFICIENT_FUNDS');
    expect(fake.count('getMinimumBalanceForRentExemption')).toBeGreaterThan(0);
  });

  it('an existing token account costs no rent', async () => {
    const need = CASE_LAMPORTS + RENT_165 + FEES + RESERVE; // wrapped SOL rent only
    const o = await order(setup({ balance: need, tokenAccountExists: true }).route);
    expect(o.transaction).not.toBeNull();
  });

  it('off devnet: WRONG_NETWORK before any pool read or send', async () => {
    const { route, fake } = setup({ genesis: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' });
    const answer = await route.getOrder({ outputMint: CASE.baseMint, amount: 1n, taker: TAKER });
    expect(answer.ok ? null : answer.code).toBe('WRONG_NETWORK');
    expect(fake.count('getProgramAccounts')).toBe(0);
    expect(fake.count('getAccountInfo')).toBe(0);
    expect(fake.count('sendTransaction')).toBe(0);
  });

  it('a sell is refused: the direct route only buys (BUNNDLY-63)', async () => {
    const { route } = setup();
    const answer = await route.getOrder({
      inputMint: CASE.baseMint,
      outputMint: 'So11111111111111111111111111111111111111112',
      amount: 1n,
      taker: TAKER,
    });
    expect(answer.ok ? null : answer.code).toBe('BAD_REQUEST');
  });

  it('the pool from the detection: no getProgramAccounts; without it the fallback reads it', async () => {
    const hinted = setup({}, { mint: CASE.baseMint, pool: CASE.pool });
    await order(hinted.route);
    await order(hinted.route);
    expect(hinted.fake.count('getProgramAccounts')).toBe(0);
    expect(hinted.route.poolSource(CASE.baseMint)).toBe('detection');

    const plain = setup();
    await order(plain.route);
    await order(plain.route);
    expect(plain.fake.count('getProgramAccounts')).toBe(1); // once per run, then by address
    expect(plain.route.poolSource(CASE.baseMint)).toBe('program-accounts');
  });

  it('a detection naming another account falls back to getProgramAccounts', async () => {
    const { route, fake } = setup({}, { mint: CASE.baseMint, pool: CASE.config });
    await order(route);
    expect(fake.count('getProgramAccounts')).toBe(1);
    expect(route.poolSource(CASE.baseMint)).toBe('program-accounts');
  });
});

describe('execute', () => {
  it('sends once and reports the tokens from the landed transaction meta', async () => {
    const { route, fake } = setup();
    const o = await order(route);
    const signed = await sign(o);
    const done = await route.execute({
      signedTransaction: signed,
      requestId: o.requestId,
      lastValidBlockHeight: 150n,
    });
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.value.status).toBe('Success');
    expect(done.value.slot).toBe(BigInt(CASE.slot));
    expect(done.value.totalInputAmount).toBe(CASE_LAMPORTS);
    expect(done.value.totalOutputAmount).toBe(CASE_TOKENS);
    expect(fake.sent).toEqual([signed]);
  });

  it('refused in preflight: NOT_SENT', async () => {
    const { route } = setup({ send: 'preflight' });
    const o = await order(route);
    const done = await route.execute({ signedTransaction: await sign(o), requestId: o.requestId });
    expect(done.ok ? null : done.code).toBe('NOT_SENT');
  });

  it('the answer to sendTransaction lost: NETWORK with the signature, sent exactly once', async () => {
    const { route, fake } = setup({ send: 'lost' });
    const o = await order(route);
    const done = await route.execute({ signedTransaction: await sign(o), requestId: o.requestId });
    expect(done.ok).toBe(false);
    if (done.ok) return;
    expect(done.code).toBe('NETWORK');
    expect(done.signature).not.toBeNull();
    expect(fake.count('sendTransaction')).toBe(1);
  });

  it('landed with an error: Failed, so the executor checks the chain before any retry', async () => {
    const { route } = setup({ landed: 'error' });
    const o = await order(route);
    const done = await route.execute({ signedTransaction: await sign(o), requestId: o.requestId });
    expect(done.ok && done.value.status).toBe('Failed');
  });

  it('not landed and the blockhash past its height: TIMEOUT, never sent again', async () => {
    const { route, fake } = setup({ landed: 'no', blockHeight: 151n });
    const o = await order(route);
    const done = await route.execute({
      signedTransaction: await sign(o),
      requestId: o.requestId,
      lastValidBlockHeight: 150n,
    });
    expect(done.ok ? null : done.code).toBe('TIMEOUT');
    expect(fake.count('sendTransaction')).toBe(1);
  });

  it('a requestId it did not build is refused without sending', async () => {
    const { route, fake } = setup();
    const o = await order(route);
    const done = await route.execute({ signedTransaction: await sign(o), requestId: 'dbc-999' });
    expect(done.ok ? null : done.code).toBe('BAD_REQUEST');
    expect(fake.count('sendTransaction')).toBe(0);
  });
});

describe('simulate', () => {
  it('simulates the signed transaction and sends nothing', async () => {
    const { route, fake } = setup();
    const o = await order(route);
    expect(await route.simulate?.(await sign(o))).toEqual({ ok: true, unitsConsumed: 61_000n });
    expect(fake.count('simulateTransaction')).toBe(1);
    expect(fake.count('sendTransaction')).toBe(0);
  });

  it('a simulation error is reported', async () => {
    const { route } = setup({ simulateError: { InstructionError: [4, { Custom: 6001n }] } });
    const o = await order(route);
    expect(await route.simulate?.(await sign(o))).toEqual({
      ok: false,
      problem: '{"InstructionError":[4,{"Custom":"6001"}]}',
    });
  });
});
