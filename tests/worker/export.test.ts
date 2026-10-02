/**
 * exportPlain (BUNNDLY-11) against the real vault handler. The keys are checked with an
 * independent Ed25519 implementation (node:crypto) against the BUNNDLY-4 vectors.
 */
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { base58 } from '@scure/base';
import { beforeAll, describe, expect, it } from 'vitest';
import { AppError, PLAIN_EXPORT_WARNING, type PlainExport } from '../../src/core/index.ts';
import { createVaultHandler, type VaultHandler } from '../../src/worker/vault.ts';

const PASSWORD = 'correct horse battery staple';
const MNEMONIC_24 = `${'abandon '.repeat(23)}art`;
/** BUNNDLY-4 reference addresses (solders / solana-keygen / Phantom), indices 0–2. */
const ADDRESSES = [
  '3Cy3YNTFywCmxoxt8n7UH6hg6dLo5uACowX3CFceaSnx',
  '5frqxtii9LeGq2bz3dSNokvZcEooF483MzeU24JrhcTA',
  '3SuKj3MZU9dMZ9oR1R7afttihZFkWpfUmduuv9rmfMa1',
];

/** Public key of an Ed25519 seed, computed by Node's own crypto (RFC 8032). */
function publicKeyOfSeed(seed: Uint8Array): Uint8Array {
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const key = createPublicKey(createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }));
  const der = key.export({ format: 'der', type: 'spki' });
  return new Uint8Array(der.subarray(der.length - 32));
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  return promise.then(
    () => undefined,
    (e: unknown) => (e instanceof AppError ? e.code : 'not an AppError'),
  );
}

let h: VaultHandler;

beforeAll(async () => {
  h = createVaultHandler();
  await h.handle({
    type: 'create',
    fleetName: 'Eksport',
    walletCount: 3,
    password: PASSWORD,
    mnemonic: MNEMONIC_24,
  });
}, 60_000);

describe('exportPlain', () => {
  it('json: mnemonic and Phantom-importable keys that match the reference addresses', async () => {
    const res = (await h.handle({
      type: 'exportPlain',
      password: PASSWORD,
      format: 'json',
    })) as PlainExport;
    expect(res.fileName).toBe('Eksport.EKSPORT-JAWNY.json');
    expect(res.mimeType).toBe('application/json');
    const json = JSON.parse(res.text) as {
      warning: string;
      mnemonic: string;
      wallets: { index: number; derivationPath: string; address: string; secretKey: string }[];
    };
    expect(json.warning).toBe(PLAIN_EXPORT_WARNING);
    expect(json.mnemonic).toBe(MNEMONIC_24);
    expect(json.wallets.map((w) => w.address)).toEqual(ADDRESSES);
    expect(json.wallets.map((w) => w.derivationPath)).toEqual([
      "m/44'/501'/0'/0'",
      "m/44'/501'/1'/0'",
      "m/44'/501'/2'/0'",
    ]);
    for (const w of json.wallets) {
      const secret = base58.decode(w.secretKey);
      expect(secret).toHaveLength(64); // Phantom's format: seed (32) + public key (32)
      expect(base58.encode(secret.subarray(32))).toBe(w.address);
      expect(base58.encode(publicKeyOfSeed(secret.subarray(0, 32)))).toBe(w.address);
    }
  }, 60_000);

  it('txt: warning, mnemonic and every wallet with path, address and key', async () => {
    const res = (await h.handle({
      type: 'exportPlain',
      password: PASSWORD,
      format: 'txt',
    })) as PlainExport;
    expect(res.fileName).toBe('Eksport.EKSPORT-JAWNY.txt');
    expect(res.text.startsWith(PLAIN_EXPORT_WARNING)).toBe(true);
    expect(res.text).toContain(MNEMONIC_24);
    for (const [i, address] of ADDRESSES.entries()) {
      expect(res.text).toContain(`indeks ${String(i)}, ścieżka m/44'/501'/${String(i)}'/0'`);
      expect(res.text).toContain(`Adres: ${address}`);
    }
    expect(res.text.match(/Klucz prywatny: [1-9A-HJ-NP-Za-km-z]{80,90}/gu)).toHaveLength(3);
  }, 60_000);

  it('a wrong password is refused when the message goes straight to the worker', async () => {
    expect(
      await codeOf(h.handle({ type: 'exportPlain', password: `${PASSWORD}!`, format: 'txt' })),
    ).toBe('KEYSTORE_WRONG_PASSWORD_OR_CORRUPTED');
    expect(await codeOf(h.handle({ type: 'exportPlain', password: '', format: 'txt' }))).toBe(
      'KEYSTORE_WRONG_PASSWORD_OR_CORRUPTED',
    );
    // the fleet stays unlocked and usable
    expect(h.inspect().unlocked).not.toBeNull();
  }, 60_000);

  it('malformed requests and a locked vault are refused', async () => {
    expect(await codeOf(h.handle({ type: 'exportPlain', format: 'txt' }))).toBe('INTERNAL_ERROR');
    expect(await codeOf(h.handle({ type: 'exportPlain', password: PASSWORD, format: 'pdf' }))).toBe(
      'INTERNAL_ERROR',
    );
    const locked = createVaultHandler();
    expect(
      await codeOf(locked.handle({ type: 'exportPlain', password: PASSWORD, format: 'txt' })),
    ).toBe('VAULT_LOCKED');
  });
});
