/**
 * The backup folder (BUNNDLY-62, SPEC 11.1): after every change of the open fleet the
 * worker writes its files into a folder the user chose once, reads each one back and
 * compares it with what it wrote. Two files: the encrypted fleet file and, while
 * WRITE_PLAIN_BACKUP is on, the recovery phrase and private keys in plain text (Krystian's
 * decision of 13.10.2026, temporary). The plain text is built here, in the worker, for the
 * write only: it is never kept, never answered to the page and never stored in the browser.
 *
 * The browser keeps only the folder handle with the fleet's name and id (IndexedDB,
 * BackupStore). Access to the folder may need the user's click again after a reload
 * (`queryPermission` answers `prompt`): then nothing is written until the page asks the
 * browser again (`requestPermission` needs a click and a window) and calls `retry`.
 */
import { AppError } from '../core/errors.ts';
import {
  buildPlainExport,
  parseKeystoreFile,
  type KeystoreFileV1,
  type KeystoreSecretsV1,
} from '../core/index.ts';
import { KEYSTORE_FILE_SUFFIX } from '../core/keystore/limits.ts';
import type { DirectoryHandleLike } from '../storage/keystore-file.ts';
import { fileIdOf } from './remember.ts';

/**
 * The one place that decides whether the plain-text file is written (SPEC 11.1, decision
 * of 13.10.2026, temporary). Off: only the encrypted file goes to the folder.
 */
export const WRITE_PLAIN_BACKUP = true;

/** `<fleet>.PLAIN-BACKUP.json`: never the name of a plain export made by hand (D-023). */
export const PLAIN_BACKUP_SUFFIX = '.PLAIN-BACKUP.json';

/** Files with these names already exist and belong to another fleet: the next free suffix. */
const MAX_SUFFIX = 20;

/** The browser's answer for the folder (`PermissionState`, not in the worker's lib). */
export type FolderPermission = 'granted' | 'denied' | 'prompt';

/** The folder handle as the worker uses it: File System Access, or a fake in tests. */
export interface BackupDirectory extends DirectoryHandleLike {
  /** Chromium: `granted`, `prompt` or `denied`; may be called in a worker without a click. */
  queryPermission?(descriptor: { readonly mode: 'readwrite' }): Promise<FolderPermission>;
}

/** What the browser keeps: the handle and the fleet it belongs to, nothing secret. */
export interface BackupFolderRecord {
  readonly handle: BackupDirectory;
  readonly fleetName: string;
  /** The fleet's name and creation time (`fileIdOf`), both in the file's public part. */
  readonly fileId: string;
}

/** IndexedDB in the worker (storage/backup-idb.ts), an in-memory value in tests. */
export interface BackupStore {
  get(): Promise<BackupFolderRecord | undefined>;
  put(record: BackupFolderRecord): Promise<void>;
  delete(): Promise<void>;
}

export type BackupFailure = 'permission' | 'write' | 'verify';

export type BackupState =
  /** No folder for the open fleet (or no fleet open). */
  | { readonly kind: 'off' }
  /** The browser needs the user's click to give access to the folder again. */
  | { readonly kind: 'reconnect'; readonly folder: string }
  | {
      readonly kind: 'saved';
      readonly folder: string;
      /** ISO time of the last write that was read back and matched. */
      readonly at: string;
    }
  | { readonly kind: 'failed'; readonly folder: string; readonly reason: BackupFailure };

/** The page's view: no file content, no handle. */
export interface BackupView {
  readonly state: BackupState;
  /** Whether the folder also gets the plain-text key file (WRITE_PLAIN_BACKUP). */
  readonly plain: boolean;
  /** Wallets with no confirmed backup: they take part in no buy and no arming. */
  readonly notBackedUp: readonly number[];
}

/** The open fleet as the backup sees it, from the vault. */
export interface BackupFleet {
  readonly fileId: string;
  readonly fleetName: string;
  /** The encrypted file text, exactly as it goes to disk. */
  readonly fileText: string;
  readonly indices: readonly number[];
  /** The fleet's secrets, asked for only while the plain file is written. */
  readonly secrets: () => KeystoreSecretsV1;
  /** False once this fleet was locked or replaced: nothing more is written for it. */
  readonly alive: () => boolean;
}

export interface BackupOptions {
  readonly store: BackupStore | null;
  readonly now: () => number;
  /** Tests only: the plain file on or off; WRITE_PLAIN_BACKUP otherwise. */
  readonly plain?: boolean;
  readonly onChange?: (view: BackupView) => void;
}

export interface Backup {
  /** A fleet was opened: `onDisk` when its file came from disk (its wallets are there). */
  opened(fleet: BackupFleet, onDisk: boolean): Promise<void>;
  /** The open fleet changed: its new file is written if the folder is ready. */
  changed(fleet: BackupFleet): Promise<void>;
  /** The user chose a folder and the vault checked the password. */
  enable(fleet: BackupFleet, handle: BackupDirectory): Promise<BackupView>;
  /** The page got the access back with a click: write now. */
  retry(fleet: BackupFleet): Promise<BackupView>;
  disable(): Promise<BackupView>;
  /** The folder handle, for the page to ask the browser for access again. */
  handle(): BackupDirectory | null;
  /** The vault locked: nothing of the fleet stays. */
  locked(): void;
  /** May this wallet buy or arm? Always with no folder: then the pending-file notice warns. */
  backedUp(index: number): boolean;
  view(): BackupView;
}

function errorName(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'name' in e && typeof e.name === 'string'
    ? e.name
    : undefined;
}

/** The plain-text backup, in the JSON format of the plain export (D-023). */
export function plainBackupText(
  file: KeystoreFileV1,
  secrets: KeystoreSecretsV1,
  at: Date,
): string {
  return buildPlainExport(file, secrets, 'json', at).text;
}

interface BackupFile {
  /** `<fleet>` + suffix; a taken name gets `-2`, `-3`… before the suffix. */
  readonly base: string;
  readonly suffix: string;
  readonly text: string;
  /** Does an existing file with this name belong to the open fleet? */
  readonly ours: (existing: string) => boolean;
}

function keystoreOwner(fileId: string): (existing: string) => boolean {
  return (existing) => {
    try {
      const file = parseKeystoreFile(existing);
      return fileIdOf(file.fleetName, file.createdAt) === fileId;
    } catch {
      return false;
    }
  };
}

/** The plain file has no creation time: the fleet name and its first wallet's address. */
function plainOwner(fleetName: string, firstAddress: string): (existing: string) => boolean {
  return (existing) => {
    try {
      const json: unknown = JSON.parse(existing);
      if (typeof json !== 'object' || json === null) return false;
      const { fleetName: name, wallets } = json as { fleetName?: unknown; wallets?: unknown };
      if (name !== fleetName || !Array.isArray(wallets)) return false;
      const first: unknown = wallets[0];
      return (
        typeof first === 'object' &&
        first !== null &&
        (first as { address?: unknown }).address === firstAddress
      );
    } catch {
      return false;
    }
  };
}

async function existingText(dir: BackupDirectory, name: string): Promise<string | null> {
  try {
    const handle = await dir.getFileHandle(name);
    return await (await handle.getFile()).text();
  } catch (e) {
    if (errorName(e) === 'NotFoundError') return null;
    throw e;
  }
}

class BackupError extends Error {
  constructor(readonly reason: BackupFailure) {
    super(reason);
  }
}

function failureOf(e: unknown): BackupFailure {
  if (e instanceof BackupError) return e.reason;
  const name = errorName(e);
  return name === 'NotAllowedError' || name === 'SecurityError' ? 'permission' : 'write';
}

export function createBackup(options: BackupOptions): Backup {
  const plain = options.plain ?? WRITE_PLAIN_BACKUP;
  let record: BackupFolderRecord | null = null;
  let state: BackupState = { kind: 'off' };
  /** The wallets of the last write read back and matched (or of a file opened from disk). */
  let confirmed = new Set<number>();
  let indices: readonly number[] = [];
  /** The names this session wrote to, so a suffixed copy keeps its name. */
  const names = new Map<string, string>();

  const view = (): BackupView => ({
    state,
    plain,
    notBackedUp: indices.filter((i) => !backedUp(i)),
  });
  const backedUp = (index: number): boolean => state.kind === 'off' || confirmed.has(index);
  /** The view last sent: a change is announced once, an unchanged one not at all. */
  let announced = JSON.stringify(view());
  const announce = (): void => {
    const next = view();
    const text = JSON.stringify(next);
    if (text === announced) return;
    announced = text;
    options.onChange?.(next);
  };
  const set = (next: BackupState): void => {
    state = next;
    announce();
  };

  /** The name to write `file` to: its own, or the first one no other fleet holds. */
  const nameFor = async (dir: BackupDirectory, file: BackupFile): Promise<string> => {
    const known = names.get(file.suffix);
    const candidates = [
      ...(known === undefined ? [] : [known]),
      ...Array.from(
        { length: MAX_SUFFIX },
        (_, i) => `${file.base}${i === 0 ? '' : `-${String(i + 1)}`}${file.suffix}`,
      ),
    ];
    for (const name of candidates) {
      const existing = await existingText(dir, name);
      if (existing === null || file.ours(existing)) return name;
    }
    throw new BackupError('write');
  };

  const writeOne = async (dir: BackupDirectory, file: BackupFile): Promise<void> => {
    const name = await nameFor(dir, file);
    const handle = await dir.getFileHandle(name, { create: true });
    if (handle.createWritable === undefined) throw new BackupError('write');
    const writable = await handle.createWritable();
    try {
      await writable.write(file.text);
      await writable.close();
    } catch (e) {
      await writable.abort?.().catch(() => undefined);
      throw e;
    }
    names.set(file.suffix, name);
    // The check: what the disk holds now, read through a new file object.
    const back = await (await (await dir.getFileHandle(name)).getFile()).text();
    if (back !== file.text) throw new BackupError('verify');
  };

  const filesOf = (fleet: BackupFleet): BackupFile[] => {
    const encrypted: BackupFile = {
      base: fleet.fleetName,
      suffix: KEYSTORE_FILE_SUFFIX,
      text: fleet.fileText,
      ours: keystoreOwner(fleet.fileId),
    };
    if (!plain) return [encrypted];
    const file = parseKeystoreFile(fleet.fileText);
    const first = [...file.public.wallets].sort((a, b) => a.index - b.index)[0];
    const plainFile: BackupFile = {
      base: fleet.fleetName,
      suffix: PLAIN_BACKUP_SUFFIX,
      // Built for this write; the array goes out of scope with it.
      text: plainBackupText(file, fleet.secrets(), new Date(options.now())),
      ours: plainOwner(fleet.fleetName, first?.address ?? ''),
    };
    return [encrypted, plainFile];
  };

  /** Writes and checks every file; the wallets count as backed up only when all match. */
  const write = async (fleet: BackupFleet): Promise<void> => {
    const current = record;
    if (current === null || current.fileId !== fleet.fileId || !fleet.alive()) return;
    const folder = current.handle.name;
    indices = fleet.indices;
    const permission =
      current.handle.queryPermission === undefined
        ? 'granted'
        : await current.handle.queryPermission({ mode: 'readwrite' }).catch(() => 'prompt');
    if (permission !== 'granted') {
      // No write without the user's click (SPEC 11.1).
      set({ kind: 'reconnect', folder });
      return;
    }
    try {
      for (const file of filesOf(fleet)) {
        if (!fleet.alive()) return;
        await writeOne(current.handle, file);
      }
    } catch (e) {
      if (fleet.alive()) set({ kind: 'failed', folder, reason: failureOf(e) });
      return;
    }
    if (!fleet.alive()) return;
    confirmed = new Set(fleet.indices);
    set({ kind: 'saved', folder, at: new Date(options.now()).toISOString() });
  };

  const load = async (): Promise<BackupFolderRecord | null> => {
    if (options.store === null) return null;
    try {
      return (await options.store.get()) ?? null;
    } catch {
      return null;
    }
  };

  return {
    async opened(fleet, onDisk) {
      names.clear();
      indices = fleet.indices;
      confirmed = new Set(onDisk ? fleet.indices : []);
      const loaded = await load();
      record = loaded?.fileId === fleet.fileId ? loaded : null;
      if (record === null) {
        set({ kind: 'off' });
        return;
      }
      await write(fleet);
    },
    async changed(fleet) {
      indices = fleet.indices;
      if (record === null) return;
      await write(fleet);
    },
    async enable(fleet, handle) {
      if (options.store === null) throw new AppError('STORAGE_WRITE_FAILED');
      const next: BackupFolderRecord = {
        handle,
        fleetName: fleet.fleetName,
        fileId: fleet.fileId,
      };
      try {
        await options.store.put(next);
      } catch {
        throw new AppError('STORAGE_WRITE_FAILED');
      }
      record = next;
      names.clear();
      // The wallets count from this folder on: none is backed up before its first write.
      confirmed = new Set();
      await write(fleet);
      return view();
    },
    async retry(fleet) {
      await write(fleet);
      return view();
    },
    async disable() {
      await options.store?.delete().catch(() => undefined);
      record = null;
      names.clear();
      set({ kind: 'off' });
      return view();
    },
    handle: () => record?.handle ?? null,
    locked() {
      record = null;
      names.clear();
      confirmed = new Set();
      indices = [];
      set({ kind: 'off' });
    },
    backedUp,
    view,
  };
}
