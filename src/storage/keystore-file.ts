/**
 * Saving and opening the keystore file (SPEC 3.1): File System Access API with a
 * download / <input type="file"> fallback for Firefox and Safari.
 *
 * Works only on the already encrypted file text; it never sees the mnemonic, password
 * or keys. Browser APIs come in through StorageEnv, so the logic is testable in Node
 * (browser.ts builds the real environment).
 */
import { AppError } from '../core/errors.ts';
import {
  KEYSTORE_FILE_SUFFIX,
  MAX_KEYSTORE_FILE_BYTES,
  isValidFleetName,
} from '../core/keystore/limits.ts';

/** Minimal structural types of the File System Access API (not in TypeScript's DOM lib). */
export interface WritableLike {
  write(data: string): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
}

export interface FileLike {
  readonly name: string;
  readonly size: number;
  text(): Promise<string>;
}

export interface FileHandleLike {
  getFile(): Promise<FileLike>;
  createWritable?(): Promise<WritableLike>;
}

export interface DirectoryHandleLike {
  readonly name: string;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FileHandleLike>;
}

export interface OpenFilePickerOptions {
  readonly id: string;
  readonly multiple: false;
  readonly excludeAcceptAllOption: boolean;
  readonly types: readonly {
    readonly description: string;
    readonly accept: Readonly<Record<string, readonly string[]>>;
  }[];
}

export interface StorageEnv {
  /** Present only where the File System Access API exists (Chrome, Edge). */
  readonly showDirectoryPicker?: (options: {
    readonly id: string;
    readonly mode: 'readwrite';
  }) => Promise<DirectoryHandleLike>;
  readonly showOpenFilePicker?: (options: OpenFilePickerOptions) => Promise<FileHandleLike[]>;
  /** Fallback reader: `<input type="file">`; resolves null when the user cancels. */
  readonly pickFileWithInput: (accept: string) => Promise<FileLike | null>;
  readonly createObjectURL: (blob: Blob) => string;
  readonly revokeObjectURL: (url: string) => void;
  /** Fallback writer: clicks an `<a download>` link for the URL. */
  readonly clickDownload: (url: string, fileName: string) => void;
  /** Timer used to release the download URL later (injectable for tests). */
  readonly setTimeout: (callback: () => void, ms: number) => void;
}

export interface SaveOptions {
  /** Asked when the file already exists in the chosen folder; false keeps the old file. */
  readonly confirmOverwrite: (fileName: string) => boolean | Promise<boolean>;
}

export type SaveResult =
  | { readonly method: 'directory'; readonly fileName: string; readonly folder: string }
  | { readonly method: 'download'; readonly fileName: string };

export interface OpenedFile {
  readonly name: string;
  readonly text: string;
}

const PICKER_ID = 'bunndly-keystore';
/**
 * How long the download URL stays alive after the click. Safari and some Firefox versions
 * can abort a download whose blob URL is revoked right away (FileSaver.js waits 40 s).
 */
export const DOWNLOAD_URL_TTL_MS = 60_000;
const JSON_ACCEPT = '.json,application/json';

/** `<fleetName>.keystore.json`; throws INVALID_FLEET_NAME for names unsafe in a path. */
export function keystoreFileName(fleetName: string): string {
  if (!isValidFleetName(fleetName)) throw new AppError('INVALID_FLEET_NAME');
  return `${fleetName}${KEYSTORE_FILE_SUFFIX}`;
}

export function supportsDirectoryPicker(env: StorageEnv): boolean {
  return typeof env.showDirectoryPicker === 'function';
}

function errorName(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'name' in e && typeof e.name === 'string'
    ? e.name
    : undefined;
}

/** Maps a browser error to a user-facing code; no browser message crosses over. */
function toStorageError(
  e: unknown,
  fallback: 'STORAGE_WRITE_FAILED' | 'STORAGE_READ_FAILED',
): AppError {
  if (e instanceof AppError) return e;
  switch (errorName(e)) {
    case 'AbortError':
      return new AppError('STORAGE_CANCELLED');
    case 'NotAllowedError':
    case 'SecurityError':
      return new AppError('STORAGE_PERMISSION_DENIED');
    default:
      return new AppError(fallback);
  }
}

async function fileExists(dir: DirectoryHandleLike, fileName: string): Promise<boolean> {
  try {
    await dir.getFileHandle(fileName);
    return true;
  } catch (e) {
    if (errorName(e) === 'NotFoundError') return false;
    throw e;
  }
}

async function saveToDirectory(
  pick: NonNullable<StorageEnv['showDirectoryPicker']>,
  fileText: string,
  fileName: string,
  options: SaveOptions,
): Promise<SaveResult> {
  const dir = await pick({ id: PICKER_ID, mode: 'readwrite' });
  if ((await fileExists(dir, fileName)) && !(await options.confirmOverwrite(fileName))) {
    throw new AppError('STORAGE_CANCELLED');
  }
  const handle = await dir.getFileHandle(fileName, { create: true });
  if (!handle.createWritable) throw new AppError('STORAGE_WRITE_FAILED');
  // createWritable writes to a temporary file that replaces the target only on close().
  const writable = await handle.createWritable();
  try {
    await writable.write(fileText);
    await writable.close();
  } catch (e) {
    await writable.abort?.().catch(() => undefined);
    throw e;
  }
  return { method: 'directory', fileName, folder: dir.name };
}

function download(env: StorageEnv, fileText: string, fileName: string): SaveResult {
  const url = env.createObjectURL(new Blob([fileText], { type: 'application/json' }));
  try {
    env.clickDownload(url, fileName);
  } catch (e) {
    env.revokeObjectURL(url); // nothing started, release at once
    throw e;
  }
  env.setTimeout(() => {
    env.revokeObjectURL(url);
  }, DOWNLOAD_URL_TTL_MS);
  return { method: 'download', fileName };
}

/**
 * Saves the encrypted keystore text as `<fleetName>.keystore.json`: into a folder the
 * user picks (File System Access API), or as a download where the API is missing.
 * Errors: INVALID_FLEET_NAME, STORAGE_CANCELLED (incl. declined overwrite),
 * STORAGE_PERMISSION_DENIED, STORAGE_WRITE_FAILED.
 */
export async function saveKeystoreFile(
  fileText: string,
  fleetName: string,
  env: StorageEnv,
  options: SaveOptions,
): Promise<SaveResult> {
  const fileName = keystoreFileName(fleetName);
  try {
    return env.showDirectoryPicker
      ? await saveToDirectory(env.showDirectoryPicker, fileText, fileName, options)
      : download(env, fileText, fileName);
  } catch (e) {
    throw toStorageError(e, 'STORAGE_WRITE_FAILED');
  }
}

/** Reads a picked file, refusing anything over 1 MB before reading its content. */
export async function readKeystoreFile(file: FileLike): Promise<OpenedFile> {
  if (file.size > MAX_KEYSTORE_FILE_BYTES) throw new AppError('STORAGE_FILE_TOO_LARGE');
  try {
    return { name: file.name, text: await file.text() };
  } catch (e) {
    throw toStorageError(e, 'STORAGE_READ_FAILED');
  }
}

/**
 * Lets the user pick a keystore file (.json) and returns its text for the vault.
 * Errors: STORAGE_CANCELLED, STORAGE_PERMISSION_DENIED, STORAGE_READ_FAILED,
 * STORAGE_FILE_TOO_LARGE.
 */
export async function openKeystoreFile(env: StorageEnv): Promise<OpenedFile> {
  let file: FileLike | null;
  try {
    if (env.showOpenFilePicker) {
      const [handle] = await env.showOpenFilePicker({
        id: PICKER_ID,
        multiple: false,
        excludeAcceptAllOption: false,
        types: [
          {
            description: 'Plik floty Bunndly (.keystore.json)',
            accept: { 'application/json': ['.json'] },
          },
        ],
      });
      file = handle ? await handle.getFile() : null;
    } else {
      file = await env.pickFileWithInput(JSON_ACCEPT);
    }
  } catch (e) {
    throw toStorageError(e, 'STORAGE_READ_FAILED');
  }
  if (file === null) throw new AppError('STORAGE_CANCELLED');
  return readKeystoreFile(file);
}
