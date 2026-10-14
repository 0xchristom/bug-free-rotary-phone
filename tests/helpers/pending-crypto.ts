/**
 * Counts WebCrypto calls that have not finished yet (BUNNDLY-75).
 *
 * WebCrypto (the vault's signing, AES-GCM of the keystore) finishes on a thread pool, not in
 * the microtask queue. A test that lets "everything resolved" run before time moves on must
 * also wait for these calls, or the next step sees a signature that is not there yet. With
 * this count the wait is for the work itself, not for a guess of how much real time it needs.
 */

const METHODS = [
  'decrypt',
  'deriveBits',
  'deriveKey',
  'digest',
  'encrypt',
  'exportKey',
  'generateKey',
  'importKey',
  'sign',
  'unwrapKey',
  'verify',
  'wrapKey',
] as const;

/** The count lives on the shared `subtle` object: every test file of a process sees one. */
const COUNT = Symbol.for('bunndly.pendingCrypto');

type Subtle = typeof globalThis.crypto.subtle;

interface Tracked {
  [COUNT]?: { pending: number };
}

function install(): { pending: number } {
  const subtle: Subtle & Tracked = globalThis.crypto.subtle;
  const existing = subtle[COUNT];
  if (existing) return existing;
  const state = { pending: 0 };
  for (const name of METHODS) {
    const original = (subtle[name] as (...args: unknown[]) => Promise<unknown>).bind(subtle);
    Object.defineProperty(subtle, name, {
      configurable: true,
      writable: true,
      value: (...args: unknown[]): Promise<unknown> => {
        state.pending++;
        return original(...args).finally(() => {
          state.pending--;
        });
      },
    });
  }
  Object.defineProperty(subtle, COUNT, { value: state });
  return state;
}

const state = install();

/** WebCrypto calls started and not finished yet. */
export function pendingCrypto(): number {
  return state.pending;
}
