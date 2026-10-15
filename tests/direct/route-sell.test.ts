/**
 * Sells through the direct Meteora DBC route (BUNNDLY-63) over a fake devnet RPC serving
 * real devnet sells of the BUNNDLY-63 test fleet (tests/fixtures/meteora-dbc-sell.devnet.json).
 * Expected numbers come from those transactions' meta (lamports and token balances), or
 * are worked out by hand here, never from the route itself.
 */
import { describe, expect, it } from 'vitest';
import { deriveWallets } from '../../src/core/index.ts';
import { checkDirectTransaction } from '../../src/direct/check.ts';
import { createDirectRoute, DIRECT_ROUTER } from '../../src/direct/route.ts';
import { SOL_MINT, type JupiterOrder } from '../../src/jupiter/client.ts';
import { signCheckedOrder } from '../../src/worker/sign-order.ts';
import { RENT_165, fakeDirectRpc, type FakeChain } from '../helpers/direct-rpc.ts';
import sells from '../fixtures/meteora-dbc-sell.devnet.json';

const [derived] = deriveWallets(`${'abandon '.repeat(11)}about`, 0, 1);
if (derived === undefined) throw new Error('fixture');
const wallet = derived;
const TAKER = wallet.address;
const [FIRST, SECOND] = sells.cases;
if (FIRST === undefined || SECOND === undefined) throw new Error('fixture');
const MINT = FIRST.baseMint;
/** Tokens the first sell gave up: 9 810 963 807 547 before, 0 after (meta token balances). */
const TOKENS = 9_810_963_807_547n;
/**
 * SOL the first sell brought its wallet, from the meta: 48 652 664 − 38 504 560 + the
 * 7 000 fee = 10 155 104. No account was left open and the wrapped SOL account was empty
 * before (the asserts below), so nothing else is in that change.
 */
const RECEIVED = 10_155_104n;
/** 5 000 per signature + ceil(200 000 units × 10 000 µlamports / 10^6) = 2 000. */
const FEES = 7_000n;

function setup(overrides: Partial<FakeChain> = {}) {
  const fake = fakeDirectRpc(TAKER, overrides, FIRST);
  let t = 0;
  const route = createDirectRoute({
    rpc: fake.rpc,
    minReserveLamports: 10_000_000n,
    now: () => t,
    sleep: (ms) => {
      t += ms;
      return Promise.resolve();
    },
  });
  return { fake, route };
}

async function sellOrder(route: ReturnType<typeof setup>['route'], slippageBps?: number) {
  const answer = await route.getOrder({
    inputMint: MINT,
    outputMint: SOL_MINT,
    amount: TOKENS,
    taker: TAKER,
    ...(slippageBps === undefined ? {} : { slippageBps }),
  });
  if (!answer.ok) throw new Error(answer.code);
  return answer.value;
}

async function sign(o: JupiterOrder): Promise<string> {
  const check = await checkDirectTransaction(o, {
    taker: TAKER,
    inputMint: MINT,
    outputMint: SOL_MINT,
    amount: TOKENS,
    maxSpend: TOKENS,
  });
  if (!check.ok) throw new Error(check.problem);
  return (await signCheckedOrder(wallet.secretKey, check.checked)).signedTransaction;
}

describe('the fixture', () => {
  it('holds the numbers the tests use, read from the meta', () => {
    expect(BigInt(FIRST.payerLamportsPost) - BigInt(FIRST.payerLamportsPre) + 7_000n).toBe(
      RECEIVED,
    );
    expect(FIRST.fee).toBe(7_000);
    expect(FIRST.createdAccounts).toEqual([]);
    expect(FIRST.outputAccountLamportsPre).toBe(0);
    expect(FIRST.payerTokenBalancesPre.map((b) => b.amount)).toEqual([String(TOKENS)]);
    expect(FIRST.payerTokenBalancesPost.map((b) => b.amount)).toEqual(['0']);
  });
});

describe('getOrder, sell', () => {
  it('quotes the SOL the real sell brought, with the Auto 5% minimum rounded down', async () => {
    const o = await sellOrder(setup().route);
    expect(o.router).toBe(DIRECT_ROUTER);
    expect([o.inputMint, o.outputMint, o.inAmount]).toEqual([MINT, SOL_MINT, TOKENS]);
    expect(o.outAmount).toBe(RECEIVED);
    // floor(10 155 104 × 9 500 / 10 000) = floor(9 647 348.8)
    expect(o.otherAmountThreshold).toBe(9_647_348n);
    expect(o.transaction).not.toBeNull();
  });

  it('the wallet’s sell slippage replaces Auto: 1% gives floor(10 053 552.96)', async () => {
    const o = await sellOrder(setup().route, 100);
    expect(o.otherAmountThreshold).toBe(10_053_552n);
  });

  it('needs only the fees and the wrapped SOL rent in SOL: 1 495 440 builds, 1 lamport less does not', async () => {
    // 1 488 440 (devnet rent of 165 bytes) + 7 000, added by hand; no reserve, no amount.
    const need = RENT_165 + FEES;
    expect(need).toBe(1_495_440n);
    expect((await sellOrder(setup({ balance: need }).route)).transaction).not.toBeNull();
    const short = await sellOrder(setup({ balance: need - 1n }).route);
    expect(short.transaction).toBeNull();
    expect(short.buildError?.reason).toBe('INSUFFICIENT_SOL_FOR_GAS');
  });

  it('off devnet: WRONG_NETWORK before any pool read', async () => {
    const { route, fake } = setup({ genesis: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d' });
    const answer = await route.getOrder({
      inputMint: MINT,
      outputMint: SOL_MINT,
      amount: TOKENS,
      taker: TAKER,
    });
    expect(answer.ok ? null : answer.code).toBe('WRONG_NETWORK');
    expect(fake.count('getAccountInfo') + fake.count('getProgramAccounts')).toBe(0);
  });

  it('token for anything but SOL, and zero tokens, are bad requests', async () => {
    const { route } = setup();
    const other = await route.getOrder({
      inputMint: MINT,
      outputMint: FIRST.config,
      amount: TOKENS,
      taker: TAKER,
    });
    expect(other.ok ? null : other.code).toBe('BAD_REQUEST');
    const zero = await route.getOrder({
      inputMint: MINT,
      outputMint: SOL_MINT,
      amount: 0n,
      taker: TAKER,
    });
    expect(zero.ok ? null : zero.code).toBe('BAD_REQUEST');
  });
});

describe('execute, sell', () => {
  it('sends once and reports the SOL from the landed meta (Δ of the fee payer + fee)', async () => {
    const { route, fake } = setup({
      payer: {
        pre: BigInt(FIRST.payerLamportsPre),
        post: BigInt(FIRST.payerLamportsPost),
        fee: 7_000n,
      },
    });
    const o = await sellOrder(route);
    const signed = await sign(o);
    const done = await route.execute({ signedTransaction: signed, requestId: o.requestId });
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.value.status).toBe('Success');
    expect(done.value.totalInputAmount).toBe(TOKENS);
    expect(done.value.totalOutputAmount).toBe(RECEIVED);
    expect(fake.sent).toEqual([signed]);
  });

  it('the curve moved below the minimum between the quote and the send: PRICE_MOVED, nothing sent', async () => {
    // Quoted at 1% on the state before the first sell; the curve is then where the first
    // sell left it, which pays less for the same tokens than 99% of the quote.
    const { route, fake } = setup();
    const o = await sellOrder(route, 100);
    const signed = await sign(o);
    fake.chain.poolData = SECOND.poolData;
    const done = await route.execute({ signedTransaction: signed, requestId: o.requestId });
    expect(done.ok ? null : done.code).toBe('PRICE_MOVED');
    expect(fake.count('sendTransaction')).toBe(0);
  });

  it('the same move within the Auto 5% is sent', async () => {
    const { route, fake } = setup();
    const o = await sellOrder(route);
    const signed = await sign(o);
    fake.chain.poolData = SECOND.poolData;
    const done = await route.execute({ signedTransaction: signed, requestId: o.requestId });
    expect(done.ok).toBe(true);
    expect(fake.count('sendTransaction')).toBe(1);
  });

  it('the curve is gone just before sending (not a pool any more): PRICE_MOVED, nothing sent', async () => {
    const { route, fake } = setup();
    const o = await sellOrder(route);
    const signed = await sign(o);
    fake.chain.poolData = 'AAAA';
    const done = await route.execute({ signedTransaction: signed, requestId: o.requestId });
    expect(done.ok ? null : done.code).toBe('PRICE_MOVED');
    expect(fake.count('sendTransaction')).toBe(0);
  });

  it('the pool cannot be read just before sending: NOT_SENT, nothing sent', async () => {
    const { route, fake } = setup();
    const o = await sellOrder(route);
    const signed = await sign(o);
    fake.chain.failing = ['getAccountInfo'];
    const done = await route.execute({ signedTransaction: signed, requestId: o.requestId });
    expect(done.ok ? null : done.code).toBe('NOT_SENT');
    expect(fake.count('sendTransaction')).toBe(0);
  });
});
