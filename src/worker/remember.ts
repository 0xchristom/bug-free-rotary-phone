/**
 * The fleet remembered on this device and the passwordless window (BUNNDLY-52, D-051).
 *
 * Kept in the page's IndexedDB by the vault worker, never by the UI thread:
 * - `account`: the encrypted fleet file text, the same one that goes to disk;
 * - `session`: the file's AES-GCM key as a non-extractable CryptoKey, plus a GCM tag
 *   over {v, fileId, expiresAt} made with that key, so a changed expiry or a record of
 *   another file is refused;
 * - `prefs`: whether to remember and how long the window lasts.
 * The password, the mnemonic and the private keys are never stored. The key itself cannot
 * be exported; whoever holds the record can only use it in this browser.
 */
import type { AesKey } from '../core/index.ts';

export interface RememberedAccountRecord {
  readonly fileText: string;
  readonly fileId: string;
}

export interface SessionRecord {
  readonly v: 1;
  readonly fileId: string;
  /** The fleet file's key; `extractable: false`, usages encrypt and decrypt. */
  readonly key: AesKey;
  readonly iv: Uint8Array;
  readonly tag: Uint8Array;
  /** ms since the epoch; null: no time limit (chosen in Settings). */
  readonly expiresAt: number | null;
}

export interface RememberPrefs {
  readonly remember: boolean;
  /** Length of the passwordless window; null: no time limit. */
  readonly windowMs: number | null;
}

export interface RememberRecords {
  readonly account: RememberedAccountRecord;
  readonly session: SessionRecord;
  readonly prefs: RememberPrefs;
}

export type RememberKey = keyof RememberRecords;

/** Storage of the records; IndexedDB in the worker, an in-memory map in tests. */
export interface RememberStore {
  get<K extends RememberKey>(key: K): Promise<RememberRecords[K] | undefined>;
  put<K extends RememberKey>(key: K, value: RememberRecords[K]): Promise<void>;
  delete(key: RememberKey): Promise<void>;
}

const MINUTE_MS = 60_000;

/** The window lengths offered in Settings; null is "no time limit". */
export const WINDOW_CHOICES: readonly (number | null)[] = [
  15 * MINUTE_MS,
  60 * MINUTE_MS,
  120 * MINUTE_MS,
  null,
];

/** Temporary decision (14.10.2026), to be confirmed: 15 minutes. */
export const DEFAULT_PREFS: RememberPrefs = { remember: true, windowMs: 15 * MINUTE_MS };

export function isWindowChoice(value: unknown): value is number | null {
  return WINDOW_CHOICES.some((choice) => choice === value);
}

/** Identifies the fleet file across saves: its name and creation time never change. */
export function fileIdOf(fleetName: string, createdAt: string): string {
  return JSON.stringify([fleetName, createdAt]);
}

function aad(fileId: string, expiresAt: number | null): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(JSON.stringify({ v: 1, fileId, expiresAt }));
}

/** A new session record for `key`, valid until `expiresAt` (null: no limit). */
export async function sealSession(
  key: AesKey,
  fileId: string,
  expiresAt: number | null,
): Promise<SessionRecord> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const tag = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad(fileId, expiresAt), tagLength: 128 },
    key,
    new Uint8Array(0),
  );
  return { v: 1, fileId, key, iv, tag: new Uint8Array(tag), expiresAt };
}

/**
 * True when the record is intact and still valid for `fileId` at `now`: its tag checks
 * against {v, fileId, expiresAt}, the expiry has not passed and the key is not
 * extractable. Never throws.
 */
export async function sessionValid(
  record: SessionRecord,
  fileId: string,
  now: number,
): Promise<boolean> {
  try {
    if (record.fileId !== fileId) return false;
    if (record.expiresAt !== null && now >= record.expiresAt) return false;
    if (record.key.extractable) return false;
    await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: new Uint8Array(record.iv),
        additionalData: aad(fileId, record.expiresAt),
        tagLength: 128,
      },
      record.key,
      new Uint8Array(record.tag),
    );
    return true;
  } catch {
    return false;
  }
}

/** What the UI may know about the remembered fleet: public data only. */
export interface RememberedView {
  /** False when the browser keeps no data for the page (e.g. a private window). */
  readonly available: boolean;
  readonly account: {
    readonly fleetName: string;
    readonly createdAt: string;
    readonly walletCount: number;
  } | null;
  readonly prefs: RememberPrefs;
}
