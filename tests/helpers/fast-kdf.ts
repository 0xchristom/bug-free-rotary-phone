/**
 * Stand-in for `@noble/hashes/scrypt.js` in tests whose subject is not the key derivation.
 *
 * Real scrypt at the lowest cost the keystore accepts (N = 2^17) takes 0.7–1.4 s here and
 * several times more on a busy machine. A test that creates or unlocks a fleet pays it at
 * least once, so files with a fleet per test sat next to the 5 s limit (BUNNDLY-65).
 *
 * A test file opts in with
 * `vi.mock('@noble/hashes/scrypt.js', () => import('../helpers/fast-kdf.ts'))`.
 * The key still depends on the password, the salt and the cost, so a wrong password or a
 * changed salt fails AES-GCM exactly as before. Real scrypt stays under test in
 * `tests/core/keystore/**` and, through the whole worker, in `tests/worker/real-kdf.test.ts`
 * (BUNNDLY-74).
 */
import { sha256 } from '@noble/hashes/sha2.js';

interface ScryptOptions {
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly dkLen?: number;
  readonly onProgress?: (progress: number) => void;
}

export function scryptAsync(
  password: Uint8Array,
  salt: Uint8Array,
  options: ScryptOptions,
): Promise<Uint8Array> {
  const cost = new TextEncoder().encode(
    `|${String(options.N)}|${String(options.r)}|${String(options.p)}`,
  );
  const input = new Uint8Array(password.length + salt.length + cost.length);
  input.set(password, 0);
  input.set(salt, password.length);
  input.set(cost, password.length + salt.length);
  const key = sha256(input).slice(0, options.dkLen ?? 32);
  input.fill(0);
  options.onProgress?.(1);
  return Promise.resolve(key);
}
