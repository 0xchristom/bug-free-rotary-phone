/**
 * IndexedDB storage of the remembered fleet (BUNNDLY-52), used inside the vault worker
 * only. One object store with three keys: `account`, `session`, `prefs`. Records are
 * stored by structured clone, so a CryptoKey stays a non-extractable CryptoKey.
 * Returns null where IndexedDB does not exist; a browser that refuses it (private
 * window) rejects the first call and the vault treats the feature as unavailable.
 */
import type { RememberKey, RememberRecords, RememberStore } from '../worker/remember.ts';

const DB_NAME = 'bunndly';
const DB_VERSION = 1;
const STORE = 'remember';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      resolve(req.result);
    };
    req.onerror = () => {
      reject(new Error('IndexedDB request failed'));
    };
  });
}

export function indexedDbRememberStore(): RememberStore | null {
  // The one sanctioned use of IndexedDB (SPEC 6 as changed for BUNNDLY-52, D-051): the
  // encrypted fleet file and the non-extractable file key, never anything in plaintext.
  // eslint-disable-next-line no-restricted-globals -- D-051, see the comment above
  if (typeof indexedDB === 'undefined') return null;
  let opening: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      // eslint-disable-next-line no-restricted-globals -- D-051, see indexedDbRememberStore
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => {
        resolve(req.result);
      };
      req.onerror = () => {
        reject(new Error('IndexedDB is not available'));
      };
      req.onblocked = () => {
        reject(new Error('IndexedDB is blocked'));
      };
    }).catch((e: unknown) => {
      opening = null; // try again on the next call
      throw e;
    });
    return opening;
  };
  const run = async <T>(
    mode: IDBTransactionMode,
    body: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> => {
    const db = await open();
    const tx = db.transaction(STORE, mode);
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => {
        resolve();
      };
      tx.onerror = () => {
        reject(new Error('IndexedDB transaction failed'));
      };
      tx.onabort = () => {
        reject(new Error('IndexedDB transaction aborted'));
      };
    });
    const result = await request(body(tx.objectStore(STORE)));
    await done;
    return result;
  };
  return {
    get: async <K extends RememberKey>(key: K) =>
      (await run('readonly', (s) => s.get(key))) as RememberRecords[K] | undefined,
    put: async (key, value) => {
      await run('readwrite', (s) => s.put(value, key));
    },
    delete: async (key) => {
      await run('readwrite', (s) => s.delete(key));
    },
  };
}
