import { base64 } from '@scure/base';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AppError,
  DEFAULT_SCRYPT_N,
  decryptSecrets,
  encryptSecrets,
  passwordLength,
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

function flipByte(b64: string, index: (length: number) => number): string {
  const bytes = base64.decode(b64);
  const i = index(bytes.length);
  bytes[i] = (bytes[i] ?? 0) ^ 0x01;
  return base64.encode(bytes);
}

let encrypted: EncryptedSecrets;

beforeAll(async () => {
  encrypted = await encryptSecrets(PLAINTEXT, PASSWORD);
});

describe('encryptSecrets / decryptSecrets', () => {
  it('uses the SPEC 3.1 shape and default parameters', () => {
    expect(encrypted.kdf).toMatchObject({ name: 'scrypt', N: DEFAULT_SCRYPT_N, r: 8, p: 1 });
    expect(DEFAULT_SCRYPT_N).toBe(131072);
    expect(base64.decode(encrypted.kdf.salt)).toHaveLength(16);
    expect(encrypted.cipher.name).toBe('AES-GCM');
    expect(base64.decode(encrypted.cipher.iv)).toHaveLength(12);
    // ciphertext = plaintext length + 16-byte GCM tag
    expect(base64.decode(encrypted.ciphertext)).toHaveLength(PLAINTEXT.length + 16);
    expect(Object.keys(encrypted).sort()).toEqual(['cipher', 'ciphertext', 'kdf']);
  });

  it('round-trips at the default N=2^17 and survives JSON', async () => {
    const fromFile = JSON.parse(JSON.stringify(encrypted)) as EncryptedSecrets;
    expect(fromFile.kdf.N).toBe(2 ** 17);
    const plain = await decryptSecrets(fromFile, PASSWORD);
    expect(plain).toEqual(PLAINTEXT);
  });

  it('does not contain the plaintext or the password', () => {
    const json = JSON.stringify(encrypted);
    expect(json).not.toContain('test only');
    expect(json).not.toContain(PASSWORD);
  });

  it('wrong password → KEYSTORE_WRONG_PASSWORD_OR_CORRUPTED', async () => {
    await expectAppError(
      decryptSecrets(encrypted, 'correct horse battery stapler'),
      'KEYSTORE_WRONG_PASSWORD_OR_CORRUPTED',
    );
  });

  it.each([
    [
      'first ciphertext byte',
      (e: EncryptedSecrets) => ({ ...e, ciphertext: flipByte(e.ciphertext, () => 0) }),
    ],
    [
      'tag byte',
      (e: EncryptedSecrets) => ({ ...e, ciphertext: flipByte(e.ciphertext, (n) => n - 1) }),
    ],
    [
      'IV byte',
      (e: EncryptedSecrets) => ({
        ...e,
        cipher: { ...e.cipher, iv: flipByte(e.cipher.iv, () => 5) },
      }),
    ],
    [
      'salt byte',
      (e: EncryptedSecrets) => ({ ...e, kdf: { ...e.kdf, salt: flipByte(e.kdf.salt, () => 3) } }),
    ],
  ])('changing one %s → same error', async (_label, tamper) => {
    await expectAppError(
      decryptSecrets(tamper(encrypted), PASSWORD),
      'KEYSTORE_WRONG_PASSWORD_OR_CORRUPTED',
    );
  });

  it('truncated or non-base64 ciphertext → KEYSTORE_WRONG_PASSWORD_OR_CORRUPTED', async () => {
    await expectAppError(
      decryptSecrets({ ...encrypted, ciphertext: base64.encode(new Uint8Array(15)) }, PASSWORD),
      'KEYSTORE_WRONG_PASSWORD_OR_CORRUPTED',
    );
    await expectAppError(
      decryptSecrets({ ...encrypted, ciphertext: '***' }, PASSWORD),
      'KEYSTORE_WRONG_PASSWORD_OR_CORRUPTED',
    );
  });

  it('two encryptions of the same data differ in salt, IV and ciphertext', async () => {
    const again = await encryptSecrets(PLAINTEXT, PASSWORD);
    expect(again.kdf.salt).not.toBe(encrypted.kdf.salt);
    expect(again.cipher.iv).not.toBe(encrypted.cipher.iv);
    expect(again.ciphertext).not.toBe(encrypted.ciphertext);
  });

  it('reports scrypt progress up to 1', async () => {
    const progress: number[] = [];
    await decryptSecrets(encrypted, PASSWORD, { onProgress: (p) => progress.push(p) });
    expect(progress.length).toBeGreaterThan(1);
    expect(progress.at(-1)).toBe(1);
  });
});

describe('parameter validation (before scrypt)', () => {
  const withKdf = (kdf: Record<string, unknown>): EncryptedSecrets => ({
    ...encrypted,
    kdf: { ...encrypted.kdf, ...kdf },
  });
  const withCipher = (cipher: Record<string, unknown>): EncryptedSecrets => ({
    ...encrypted,
    cipher: { ...encrypted.cipher, ...cipher },
  });

  it.each([
    ['N = 2^30', () => withKdf({ N: 2 ** 30 })],
    ['N = 2^21', () => withKdf({ N: 2 ** 21 })],
    ['N = 2^16 (too weak)', () => withKdf({ N: 2 ** 16 })],
    ['N not a power of 2', () => withKdf({ N: 131071 })],
    ['N as string', () => withKdf({ N: '131072' })],
    ['N fractional', () => withKdf({ N: 131072.5 })],
    ['r = 16', () => withKdf({ r: 16 })],
    ['r = 1', () => withKdf({ r: 1 })],
    ['p = 0', () => withKdf({ p: 0 })],
    ['p = 5', () => withKdf({ p: 5 })],
    ['unknown KDF', () => withKdf({ name: 'argon2id' })],
    ['pbkdf2', () => withKdf({ name: 'pbkdf2' })],
    ['unknown cipher', () => withCipher({ name: 'AES-CBC' })],
    ['salt of 15 bytes', () => withKdf({ salt: base64.encode(new Uint8Array(15)) })],
    ['salt not base64', () => withKdf({ salt: '!!' })],
    ['IV of 16 bytes', () => withCipher({ iv: base64.encode(new Uint8Array(16)) })],
    ['missing IV', () => withCipher({ iv: undefined })],
    ['missing kdf', () => ({ ...encrypted, kdf: null }) as unknown as EncryptedSecrets],
  ])('%s → KEYSTORE_UNSUPPORTED_KDF immediately, scrypt not run', async (_label, makeInput) => {
    const input = makeInput();
    const onProgress = vi.fn();
    const started = performance.now();
    await expectAppError(
      decryptSecrets(input, PASSWORD, { onProgress }),
      'KEYSTORE_UNSUPPORTED_KDF',
    );
    expect(performance.now() - started).toBeLessThan(100);
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('rejects out-of-range cost on encrypt too, before scrypt', async () => {
    const onProgress = vi.fn();
    await expectAppError(
      encryptSecrets(PLAINTEXT, PASSWORD, { kdf: { N: 2 ** 30 }, onProgress }),
      'KEYSTORE_UNSUPPORTED_KDF',
    );
    await expectAppError(
      encryptSecrets(PLAINTEXT, PASSWORD, { kdf: { p: 8 }, onProgress }),
      'KEYSTORE_UNSUPPORTED_KDF',
    );
    expect(onProgress).not.toHaveBeenCalled();
  });
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

describe('environment', () => {
  it('uses the global WebCrypto in Node without polyfills', () => {
    expect(typeof globalThis.crypto.subtle.importKey).toBe('function');
  });
});
