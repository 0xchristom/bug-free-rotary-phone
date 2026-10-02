/**
 * Signing `/order` transactions in the vault (BUNNDLY-22): checks first, key only after,
 * partial signature, independent Ed25519 verification with node:crypto.
 */
import { createPublicKey, verify } from 'node:crypto';
import { base58, base64 } from '@scure/base';
import { getBase64Encoder, getTransactionDecoder } from '@solana/kit';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppError, defaultFleetSettings } from '../../src/core/index.ts';
import type { VaultFileResult, VaultStatus } from '../../src/worker/protocol.ts';
import { createVaultHandler, type VaultHandler } from '../../src/worker/vault.ts';
import * as signing from '../../src/worker/sign-order.ts';
import { MAKER, OTHER_SIGNER, USDC, buildTransaction, orderFor } from '../helpers/tx-fakes.ts';

vi.mock('../../src/worker/sign-order.ts', { spy: true });

const PASSWORD = 'correct horse battery staple';
const MNEMONIC_12 = `${'abandon '.repeat(11)}about`;
const MAX_SPEND = 10_000_000n;

let h: VaultHandler;
let W0: string;
let W1: string;

function ed25519Verify(signer: string, message: Uint8Array, signature: Uint8Array): boolean {
  const key = createPublicKey({
    key: {
      kty: 'OKP',
      crv: 'Ed25519',
      x: base64
        .encode(base58.decode(signer))
        .replace(/=+$/u, '')
        .replace(/\+/gu, '-')
        .replace(/\//gu, '_'),
    },
    format: 'jwk',
  });
  return verify(null, message, key, signature);
}

beforeAll(async () => {
  h = createVaultHandler();
  await h.handle({
    type: 'create',
    fleetName: 'Podpis',
    walletCount: 2,
    password: PASSWORD,
    mnemonic: MNEMONIC_12,
  });
  const settings = { ...defaultFleetSettings(), maxSpend: [{ index: 0, lamports: MAX_SPEND }] };
  (await h.handle({ type: 'saveSettings', settings })) as VaultFileResult;
  const status = (await h.handle({ type: 'status' })) as VaultStatus;
  const wallets = status.info?.wallets ?? [];
  W0 = wallets[0]?.address ?? '';
  W1 = wallets[1]?.address ?? '';
});

afterEach(() => {
  vi.mocked(signing.signCheckedOrder).mockClear();
});

const ask = { outputMint: USDC, amount: MAX_SPEND };

describe('signOrder', () => {
  it('taker pays: signs its slot; the signature verifies with node:crypto Ed25519', async () => {
    const tx = buildTransaction({ feePayer: W0 });
    const r = await h.signOrder(0, ask, orderFor(W0, tx));
    if (!r.ok) throw new Error(r.problem);
    const signed = getTransactionDecoder().decode(getBase64Encoder().encode(r.signedTransaction));
    const sig = Object.values(signed.signatures)[0];
    if (!sig) throw new Error('no signature');
    expect(ed25519Verify(W0, new Uint8Array(signed.messageBytes), new Uint8Array(sig))).toBe(true);
    expect(r.signature).toBe(base58.encode(new Uint8Array(sig)));
    expect(signing.signCheckedOrder).toHaveBeenCalledTimes(1);
    // the message itself is untouched
    const before = getTransactionDecoder().decode(getBase64Encoder().encode(tx));
    expect(new Uint8Array(signed.messageBytes)).toEqual(new Uint8Array(before.messageBytes));
  });

  it('market maker pays: only the taker slot is filled, the maker signature stays byte for byte', async () => {
    const makerSig = new Uint8Array(64).map((_, i) => (i * 7 + 3) % 256);
    const tx = buildTransaction({
      feePayer: MAKER,
      signers: [W0],
      preSigned: { [MAKER]: makerSig },
    });
    const r = await h.signOrder(0, ask, orderFor(W0, tx, { signatureFeePayer: MAKER }));
    if (!r.ok) throw new Error(r.problem);
    expect(r.signature).toBeNull();
    const signed = getTransactionDecoder().decode(getBase64Encoder().encode(r.signedTransaction));
    const sigs = signed.signatures as Record<string, Uint8Array | null>;
    expect(new Uint8Array(sigs[MAKER] ?? [])).toEqual(makerSig);
    expect(
      ed25519Verify(W0, new Uint8Array(signed.messageBytes), new Uint8Array(sigs[W0] ?? [])),
    ).toBe(true);
    // and a market maker slot left empty stays empty
    const open = buildTransaction({ feePayer: MAKER, signers: [W0] });
    const r2 = await h.signOrder(0, ask, orderFor(W0, open, { signatureFeePayer: MAKER }));
    if (!r2.ok) throw new Error(r2.problem);
    const s2 = getTransactionDecoder().decode(getBase64Encoder().encode(r2.signedTransaction));
    expect((s2.signatures as Record<string, unknown>)[MAKER]).toBeNull();
  });

  it.each([
    [
      'another wallet’s transaction',
      () => orderFor(W1, buildTransaction({ feePayer: W1 })),
      'TAKER_MISMATCH',
    ],
    [
      'fee payer not signatureFeePayer',
      () => orderFor(W0, buildTransaction({ feePayer: MAKER, signers: [W0] })),
      'FEE_PAYER_MISMATCH',
    ],
    [
      'no slot for the wallet',
      () => orderFor(W0, buildTransaction({ feePayer: W1 }), { signatureFeePayer: W1 }),
      'TAKER_NOT_SIGNER',
    ],
    [
      'more than 2 signatures',
      () =>
        orderFor(W0, buildTransaction({ feePayer: MAKER, signers: [W0, OTHER_SIGNER] }), {
          signatureFeePayer: MAKER,
        }),
      'TOO_MANY_SIGNERS',
    ],
    [
      'legacy transaction',
      () => orderFor(W0, buildTransaction({ feePayer: W0, version: 'legacy' })),
      'NOT_V0',
    ],
    ['damaged bytes', () => orderFor(W0, 'AQAB////'), 'UNDECODABLE'],
    [
      'inAmount above max spend',
      () => orderFor(W0, buildTransaction({ feePayer: W0 }), { inAmount: MAX_SPEND + 1n }),
      'OVER_MAX_SPEND',
    ],
    [
      'another output mint',
      () => orderFor(W0, buildTransaction({ feePayer: W0 }), { outputMint: MAKER }),
      'OUTPUT_MINT_MISMATCH',
    ],
  ] as const)('%s → %s, the key is not used', async (_name, order, problem) => {
    const r = await h.signOrder(0, ask, order());
    expect(r).toEqual({ ok: false, problem });
    expect(signing.signCheckedOrder).not.toHaveBeenCalled();
  });

  it('max spend comes from the vault: a wallet without max spend signs nothing', async () => {
    const tx = buildTransaction({ feePayer: W1 });
    const r = await h.signOrder(1, ask, orderFor(W1, tx));
    expect(r).toEqual({ ok: false, problem: 'OVER_MAX_SPEND' });
    expect(signing.signCheckedOrder).not.toHaveBeenCalled();
  });

  it('unknown wallet and a locked vault', async () => {
    expect(await h.signOrder(9, ask, orderFor(W0, buildTransaction({ feePayer: W0 })))).toEqual({
      ok: false,
      problem: 'UNKNOWN_WALLET',
    });
    const locked = createVaultHandler();
    expect(
      await locked.signOrder(0, ask, orderFor(W0, buildTransaction({ feePayer: W0 }))),
    ).toEqual({
      ok: false,
      problem: 'VAULT_LOCKED',
    });
    expect(signing.signCheckedOrder).not.toHaveBeenCalled();
  });

  it('the message protocol has no signing request', async () => {
    const order = orderFor(W0, buildTransaction({ feePayer: W0 }));
    for (const type of ['signOrder', 'sign', 'signTransaction']) {
      const caught: unknown = await h.handle({ type, walletIndex: 0, request: ask, order }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(caught).toBeInstanceOf(AppError);
      expect((caught as AppError).code).toBe('INTERNAL_ERROR');
    }
    expect(signing.signCheckedOrder).not.toHaveBeenCalled();
  });
});
