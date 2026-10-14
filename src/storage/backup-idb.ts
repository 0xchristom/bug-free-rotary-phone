/**
 * IndexedDB storage of the backup folder (BUNNDLY-62), used inside the vault worker only.
 * One record: the folder's handle (the browser clones it, access rights stay with the
 * browser) and the fleet's name and id. Nothing secret: no file content, no password,
 * no key. A database of its own, so the remembered fleet's (remember-idb.ts) stays as is.
 * Returns null where IndexedDB does not exist.
 */
import type { BackupFolderRecord, BackupStore } from '../worker/backup.ts';

const DB_NAME = 'bunndly-backup';
const DB_VERSION = 1;
const STORE = 'folder';
const KEY = 'folder';

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

export function indexedDbBackupStore(): BackupStore | null {
  // The backup folder's handle and the fleet's name (D-061): nothing secret is stored.
  // eslint-disable-next-line no-restricted-globals -- D-061, see the comment above
  if (typeof indexedDB === 'undefined') return null;
  let opening: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      // eslint-disable-next-line no-restricted-globals -- D-061, see indexedDbBackupStore
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
    get: async () => (await run('readonly', (s) => s.get(KEY))) as BackupFolderRecord | undefined,
    put: async (record) => {
      await run('readwrite', (s) => s.put(record, KEY));
    },
    delete: async () => {
      await run('readwrite', (s) => s.delete(KEY));
    },
  };
}
