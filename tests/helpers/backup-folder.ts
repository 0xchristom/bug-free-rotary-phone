/**
 * Stand-ins for the backup folder (BUNNDLY-62): a folder in memory with the parts of the
 * File System Access API the worker uses, and the store of its handle.
 *
 * The store clones the record like IndexedDB, except the handle: the browser clones a
 * real handle with its access, a fake keeps its methods only by reference.
 */
import type {
  BackupDirectory,
  BackupFolderRecord,
  BackupStore,
  FolderPermission,
} from '../../src/worker/backup.ts';

interface Named extends Error {
  readonly name: string;
}

function domError(name: string): Named {
  const e = new Error(name);
  e.name = name;
  return e;
}

export interface MemoryFolder extends BackupDirectory {
  /** What the disk holds, by file name. */
  readonly files: Map<string, string>;
  /** Every completed write, in order. */
  readonly writes: { readonly name: string; readonly text: string }[];
  /** Calls of queryPermission. */
  readonly asked: { count: number };
  permission: FolderPermission;
  /** The next close of a writable fails (a full disk, a removed folder). */
  failWrites: boolean;
  /** Reads give back something else than was written (a damaged disk). */
  corruptReads: boolean;
}

export function memoryFolder(name = 'Bunndly backups'): MemoryFolder {
  const folder: MemoryFolder = {
    name,
    files: new Map(),
    writes: [],
    asked: { count: 0 },
    permission: 'granted',
    failWrites: false,
    corruptReads: false,
    queryPermission() {
      folder.asked.count += 1;
      return Promise.resolve(folder.permission);
    },
    getFileHandle(fileName, options = {}) {
      if (folder.permission !== 'granted') return Promise.reject(domError('NotAllowedError'));
      if (!folder.files.has(fileName) && options.create !== true) {
        return Promise.reject(domError('NotFoundError'));
      }
      return Promise.resolve({
        getFile: () => {
          const text = folder.files.get(fileName) ?? '';
          const read = folder.corruptReads ? `${text} ` : text;
          return Promise.resolve({
            name: fileName,
            size: read.length,
            text: () => Promise.resolve(read),
          });
        },
        createWritable: () => {
          let buffer = '';
          return Promise.resolve({
            write: (data: string) => {
              buffer += data;
              return Promise.resolve();
            },
            close: () => {
              if (folder.failWrites) return Promise.reject(domError('InvalidStateError'));
              folder.files.set(fileName, buffer);
              folder.writes.push({ name: fileName, text: buffer });
              return Promise.resolve();
            },
            abort: () => Promise.resolve(),
          });
        },
      });
    },
  };
  return folder;
}

export interface MemoryBackupStore extends BackupStore {
  /** The stored record with the handle replaced by its folder name: for content scans. */
  readonly dump: () => unknown;
}

export function memoryBackupStore(): MemoryBackupStore {
  let stored: { handle: BackupDirectory; rest: unknown } | null = null;
  return {
    get: () => {
      if (stored === null) return Promise.resolve(undefined);
      const rest = structuredClone(stored.rest) as Omit<BackupFolderRecord, 'handle'>;
      return Promise.resolve({ ...rest, handle: stored.handle });
    },
    put: (record) => {
      const { handle, ...rest } = record;
      stored = { handle, rest: structuredClone(rest) };
      return Promise.resolve();
    },
    delete: () => {
      stored = null;
      return Promise.resolve();
    },
    dump: () =>
      stored === null
        ? null
        : { ...(structuredClone(stored.rest) as object), handle: `[handle ${stored.handle.name}]` },
  };
}
