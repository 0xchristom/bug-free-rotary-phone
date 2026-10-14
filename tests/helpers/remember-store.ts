/**
 * In-memory stand-in for the IndexedDB store of the remembered fleet (BUNNDLY-52). Values
 * go in and come out by structured clone, as with IndexedDB, so a CryptoKey read back is
 * a clone with the same `extractable` and usages, and changing a read record changes
 * nothing stored. `failing()` simulates a browser that refuses IndexedDB.
 */
import type { RememberKey, RememberRecords, RememberStore } from '../../src/worker/remember.ts';

export interface MemoryRememberStore extends RememberStore {
  /** Everything stored, cloned: for scans of the whole content. */
  readonly dump: () => Partial<Record<RememberKey, unknown>>;
  readonly keys: () => RememberKey[];
}

export function memoryRememberStore(): MemoryRememberStore {
  const data = new Map<RememberKey, unknown>();
  return {
    get: <K extends RememberKey>(key: K) =>
      Promise.resolve(
        data.has(key) ? (structuredClone(data.get(key)) as RememberRecords[K]) : undefined,
      ),
    put: (key, value) => {
      data.set(key, structuredClone(value));
      return Promise.resolve();
    },
    delete: (key) => {
      data.delete(key);
      return Promise.resolve();
    },
    dump: () => Object.fromEntries([...data].map(([k, v]) => [k, structuredClone(v)])),
    keys: () => [...data.keys()].sort(),
  };
}

/** A store whose every call fails, like IndexedDB in a private window. */
export function failingRememberStore(): RememberStore {
  const fail = (): Promise<never> => Promise.reject(new Error('IndexedDB is not available'));
  return { get: fail, put: fail, delete: fail };
}
