/** Checks before signing (BUNNDLY-22), keyless: real `/order` transactions and built ones. */
import { describe, expect, it } from 'vitest';
import {
  ORDER_CHECK_MESSAGES,
  checkOrderTransaction,
  type OrderCheckProblem,
} from '../../src/executor/order-check.ts';
import {
  MAKER,
  OTHER_SIGNER,
  USDC,
  buildTransaction,
  orderFor,
  realOrder,
} from '../helpers/tx-fakes.ts';

const TAKER = 'sp1nLqqjVZ1kTusFjJmHp1xHDpH6M4F7KXCr1iJ3xpX';
const OTHER_WALLET = '83foSi1gUPjSCSFmdd2xrGxHad5sXrhbFFMxsh8iHBd7';
const expectFor = (amount: bigint, maxSpend = amount, taker = TAKER) => ({
  taker,
  outputMint: USDC,
  amount,
  maxSpend,
});

describe('real /order transactions (fixtures, public address)', () => {
  it('metis: the taker pays the fee and signs alone → passes', () => {
    const order = realOrder('metisSuccess');
    const r = checkOrderTransaction(order, expectFor(order.inAmount));
    expect(r.ok && r.checked.takerPaysFee).toBe(true);
  });

  it('jupiterz: the market maker pays and signs too → passes, taker is not the fee payer', () => {
    const order = realOrder('jupiterzSuccess');
    const r = checkOrderTransaction(order, expectFor(order.inAmount));
    expect(r.ok).toBe(true);
    expect(r.ok && r.checked.takerPaysFee).toBe(false);
  });

  it('the same real transactions for another wallet are refused', () => {
    for (const name of ['metisSuccess', 'jupiterzSuccess'] as const) {
      const order = realOrder(name);
      expect(
        checkOrderTransaction(order, expectFor(order.inAmount, order.inAmount, OTHER_WALLET)),
      ).toEqual({ ok: false, problem: 'TAKER_MISMATCH' });
      // the answer claims our taker but the transaction is someone else's
      expect(
        checkOrderTransaction(
          { ...order, taker: OTHER_WALLET },
          expectFor(order.inAmount, order.inAmount, OTHER_WALLET),
        ),
      ).toEqual({ ok: false, problem: 'TAKER_NOT_SIGNER' });
    }
  });
});

describe('every refusal has its own code', () => {
  const own = buildTransaction({ feePayer: TAKER });
  const cases: [string, Parameters<typeof checkOrderTransaction>[0], OrderCheckProblem][] = [
    ['no transaction', orderFor(TAKER, null), 'NO_TRANSACTION'],
    ['another wallet in the answer', orderFor(OTHER_WALLET, own), 'TAKER_MISMATCH'],
    ['not paying in SOL', orderFor(TAKER, own, { inputMint: USDC }), 'INPUT_MINT_MISMATCH'],
    ['another output mint', orderFor(TAKER, own, { outputMint: MAKER }), 'OUTPUT_MINT_MISMATCH'],
    ['inAmount above max spend', orderFor(TAKER, own, { inAmount: 10_000_001n }), 'OVER_MAX_SPEND'],
    [
      'inAmount not what was asked',
      orderFor(TAKER, own, { inAmount: 9_000_000n }),
      'AMOUNT_MISMATCH',
    ],
    ['damaged bytes', orderFor(TAKER, 'AAAA'), 'UNDECODABLE'],
    ['cut transaction', orderFor(TAKER, own.slice(0, 40)), 'UNDECODABLE'],
    [
      'legacy transaction',
      orderFor(TAKER, buildTransaction({ feePayer: TAKER, version: 'legacy' })),
      'NOT_V0',
    ],
    [
      'more than 2 signers',
      orderFor(TAKER, buildTransaction({ feePayer: MAKER, signers: [TAKER, OTHER_SIGNER] }), {
        signatureFeePayer: MAKER,
      }),
      'TOO_MANY_SIGNERS',
    ],
    [
      'wallet not a signer',
      orderFor(TAKER, buildTransaction({ feePayer: OTHER_WALLET }), {
        signatureFeePayer: OTHER_WALLET,
      }),
      'TAKER_NOT_SIGNER',
    ],
    [
      'wallet slot already filled',
      orderFor(
        TAKER,
        buildTransaction({ feePayer: TAKER, preSigned: { [TAKER]: new Uint8Array(64).fill(7) } }),
      ),
      'TAKER_ALREADY_SIGNED',
    ],
    [
      'fee payer not signatureFeePayer',
      orderFor(TAKER, buildTransaction({ feePayer: MAKER, signers: [TAKER] })),
      'FEE_PAYER_MISMATCH',
    ],
    [
      'no signatureFeePayer and someone else pays',
      orderFor(TAKER, buildTransaction({ feePayer: MAKER, signers: [TAKER] }), {
        signatureFeePayer: null,
      }),
      'FEE_PAYER_MISMATCH',
    ],
  ];
  it.each(cases)('%s → %s', (_name, order, problem) => {
    expect(checkOrderTransaction(order, expectFor(10_000_000n))).toEqual({ ok: false, problem });
    expect(ORDER_CHECK_MESSAGES[problem]).toMatch(/\p{Lu}/u);
  });

  it('a gas sponsor or market maker as fee payer passes when the answer names it', () => {
    const tx = buildTransaction({ feePayer: MAKER, signers: [TAKER] });
    const r = checkOrderTransaction(
      orderFor(TAKER, tx, { signatureFeePayer: MAKER }),
      expectFor(10_000_000n),
    );
    expect(r.ok).toBe(true);
  });

  it('no signatureFeePayer means the taker must pay', () => {
    const tx = buildTransaction({ feePayer: TAKER });
    const r = checkOrderTransaction(
      orderFor(TAKER, tx, { signatureFeePayer: null }),
      expectFor(10_000_000n),
    );
    expect(r.ok).toBe(true);
  });
});
