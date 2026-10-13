/**
 * The scrypt stand-in must not make every password open every file: the tests that use it
 * still rely on "the same password opens it, another one does not".
 */
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/core/errors.ts';
import { decryptSecrets, encryptSecrets } from '../../src/core/keystore/crypto.ts';
import { scryptAsync } from './fast-kdf.ts';

vi.mock('@noble/hashes/scrypt.js', () => import('./fast-kdf.ts'));

const PASSWORD = 'correct horse battery staple';
const SECRET = new TextEncoder().encode('abandon abandon about');

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  return promise.then(
    () => undefined,
    (e: unknown) => (e instanceof AppError ? e.code : 'not an AppError'),
  );
}

describe('scrypt stand-in for tests', () => {
  it('the same password opens the secrets, another password does not', async () => {
    const encrypted = await encryptSecrets(SECRET, PASSWORD);
    expect(await decryptSecrets(encrypted, PASSWORD)).toEqual(SECRET);
    expect(await codeOf(decryptSecrets(encrypted, `${PASSWORD}!`))).toBe(
      'KEYSTORE_WRONG_PASSWORD_OR_CORRUPTED',
    );
  });

  it('the key depends on the password, the salt and the cost', async () => {
    const pw = new TextEncoder().encode(PASSWORD);
    const salt = new Uint8Array(32).fill(7);
    const cost = { N: 2 ** 17, r: 8, p: 1, dkLen: 32 };
    const hex = async (...args: Parameters<typeof scryptAsync>): Promise<string> =>
      Buffer.from(await scryptAsync(...args)).toString('hex');
    const base = await hex(pw, salt, cost);
    expect(base).toHaveLength(64);
    expect(await hex(pw, salt, cost)).toBe(base);
    expect(await hex(new TextEncoder().encode(`${PASSWORD}!`), salt, cost)).not.toBe(base);
    expect(await hex(pw, new Uint8Array(32).fill(8), cost)).not.toBe(base);
    expect(await hex(pw, salt, { ...cost, N: 2 ** 18 })).not.toBe(base);
    expect(await hex(pw, salt, { ...cost, p: 2 })).not.toBe(base);
  });

  it('reports progress once, at the end', async () => {
    const seen: number[] = [];
    await scryptAsync(new Uint8Array(1), new Uint8Array(32), {
      N: 2 ** 17,
      r: 8,
      p: 1,
      onProgress: (p) => seen.push(p),
    });
    expect(seen).toEqual([1]);
  });
});
