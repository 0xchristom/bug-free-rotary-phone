/**
 * Passwords, sessions and the environment of the keystore crypto, with real scrypt at the
 * default N=2^17 (the derivation is the subject). Split out of crypto.test.ts in BUNNDLY-74
 * so the two halves run in parallel.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AppError,
  createSession,
  decryptSecrets,
  decryptWithSession,
  encryptSecrets,
  encryptWithSession,
  passwordLength,
  unlockSession,
  type EncryptedSecrets,
} from '../../../src/core/index.ts';

// Real scrypt at the default N=2^17 (about 1 s per derivation), never lowered.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const PASSWORD = 'correct horse battery staple';
const PLAINTEXT = new TextEncoder().encode(
  JSON.stringify({ mnemonic: 'test only', keys: ['k1', 'k2'] }),
);

async function expectAppError(promise: Promise<unknown>, code: AppError['code']): Promise<void> {
  const err: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe(code);
  expect('cause' in (err as AppError)).toBe(false);
}

let encrypted: EncryptedSecrets;

beforeAll(async () => {
  encrypted = await encryptSecrets(PLAINTEXT, PASSWORD);
});

describe('password', () => {
  it.each(['', 'short', '12345678901', 'zażółć gęś'])(
    '%j (< 12 characters) → PASSWORD_TOO_SHORT',
    async (pw) => {
      await expectAppError(encryptSecrets(PLAINTEXT, pw), 'PASSWORD_TOO_SHORT');
    },
  );

  it('counts user-perceived characters after NFKC', () => {
    expect(passwordLength('123456789012')).toBe(12);
    // "ą" as NFD is two code points but one character
    expect(passwordLength('ą'.normalize('NFD').repeat(12))).toBe(12);
    expect(passwordLength('ą'.normalize('NFD').repeat(11))).toBe(11);
  });

  it('Polish password in NFC and NFD decrypts the same ciphertext', async () => {
    const polish = 'Zażółć gęślą jaźń 2026';
    const nfc = polish.normalize('NFC');
    const nfd = polish.normalize('NFD');
    expect(nfc).not.toBe(nfd);
    const sealed = await encryptSecrets(PLAINTEXT, nfc);
    expect(await decryptSecrets(sealed, nfd)).toEqual(PLAINTEXT);
    expect(await decryptSecrets(sealed, nfc)).toEqual(PLAINTEXT);
  });
});

describe('sessions (re-encrypting without the password)', () => {
  it('unlockSession returns a non-extractable key that decrypts and re-encrypts', async () => {
    const { plaintext, session } = await unlockSession(encrypted, PASSWORD);
    expect(plaintext).toEqual(PLAINTEXT);
    expect(session.kdf).toEqual(encrypted.kdf);
    expect(session.key.extractable).toBe(false);
    expect([...session.key.usages].sort()).toEqual(['decrypt', 'encrypt']);

    const again = await encryptWithSession(PLAINTEXT, session);
    expect(again.kdf).toEqual(encrypted.kdf); // same salt and cost
    expect(again.cipher.iv).not.toBe(encrypted.cipher.iv);
    expect(await decryptWithSession(again, session)).toEqual(PLAINTEXT);
    // and the password still opens it (no session needed)
    expect(await decryptSecrets(again, PASSWORD)).toEqual(PLAINTEXT);
  });

  it('each encryptWithSession uses a fresh IV', async () => {
    const session = await createSession(PASSWORD);
    const a = await encryptWithSession(PLAINTEXT, session);
    const b = await encryptWithSession(PLAINTEXT, session);
    expect(a.cipher.iv).not.toBe(b.cipher.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.kdf.salt).toBe(b.kdf.salt);
    // a different session (other salt) cannot decrypt it
    const { session: other } = await unlockSession(encrypted, PASSWORD);
    await expectAppError(decryptWithSession(a, other), 'KEYSTORE_WRONG_PASSWORD_OR_CORRUPTED');
  });

  it('createSession checks the password before scrypt', async () => {
    const onProgress = vi.fn();
    await expectAppError(createSession('short', { onProgress }), 'PASSWORD_TOO_SHORT');
    expect(onProgress).not.toHaveBeenCalled();
  });
});

describe('environment', () => {
  it('uses the global WebCrypto in Node without polyfills', () => {
    expect(typeof globalThis.crypto.subtle.importKey).toBe('function');
  });
});
