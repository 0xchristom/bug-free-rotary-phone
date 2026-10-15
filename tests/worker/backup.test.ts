/**
 * The backup folder (BUNNDLY-62, SPEC 11.1) through the real vault handler: the worker
 * writes both files, reads them back, and only then counts the wallets as backed up.
 * Folder and handle store are in memory (tests/helpers/backup-folder.ts).
 */
import { base58 } from '@scure/base';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  AppError,
  createKeystore,
  defaultFleetSettings,
  serializeKeystoreFile,
} from '../../src/core/index.ts';
import {
  PLAIN_BACKUP_SUFFIX,
  createBackup,
  type BackupFleet,
  type BackupView,
} from '../../src/worker/backup.ts';
import type { VaultFileResult, VaultStatus, WorkerEvent } from '../../src/worker/protocol.ts';
import { createVaultHandler, type VaultHandler } from '../../src/worker/vault.ts';
import {
  memoryBackupStore,
  memoryFolder,
  type MemoryBackupStore,
  type MemoryFolder,
} from '../helpers/backup-folder.ts';

vi.mock('@noble/hashes/scrypt.js', () => import('../helpers/fast-kdf.ts'));

const PASSWORD = 'zielony Kot, 7 krzeseł; drabina';
const MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const FLEET = 'Kopia';
const KEYSTORE = `${FLEET}.keystore.json`;
const PLAIN = `${FLEET}${PLAIN_BACKUP_SUFFIX}`;
const T0 = Date.UTC(2026, 9, 15, 1, 2, 3);

async function call<T>(h: VaultHandler, request: unknown): Promise<T> {
  return (await h.handle(request)) as T;
}

async function codeOf(promise: Promise<unknown>): Promise<string | null> {
  const caught: unknown = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  return caught instanceof AppError ? caught.code : null;
}

interface Setup {
  readonly h: VaultHandler;
  readonly store: MemoryBackupStore;
  readonly folder: MemoryFolder;
  readonly events: WorkerEvent[];
  readonly answers: unknown[];
  readonly created: VaultFileResult;
}

/** A fleet of 2 wallets with the Helius key set; the folder is not on yet. */
async function setup(store = memoryBackupStore(), folder = memoryFolder()): Promise<Setup> {
  const h = createVaultHandler({ now: () => T0, backup: store, autoLockMs: 3_600_000 });
  const events: WorkerEvent[] = [];
  h.onEvent((e) => events.push(e));
  const answers: unknown[] = [];
  const created = await call<VaultFileResult>(h, {
    type: 'create',
    fleetName: FLEET,
    walletCount: 2,
    password: PASSWORD,
    mnemonic: MNEMONIC,
  });
  answers.push(created);
  const base = defaultFleetSettings();
  answers.push(
    await call(h, {
      type: 'saveSettings',
      settings: {
        ...base,
        maxSpend: [
          { index: 0, lamports: 10_000_000n },
          { index: 1, lamports: 10_000_000n },
        ],
      },
      apiKeys: { helius: 'heliusBackupKey123' },
    }),
  );
  return { h, store, folder, events, answers, created };
}

async function enable(s: Setup, password = PASSWORD): Promise<BackupView> {
  const view = await call<BackupView>(s.h, {
    type: 'enableBackup',
    handle: s.folder,
    password,
  });
  s.answers.push(view);
  return view;
}

function secretsOf(h: VaultHandler): string[] {
  const v = h.inspect().unlocked;
  if (!v) return [];
  return [
    new TextDecoder().decode(v.mnemonic),
    ...v.wallets.flatMap((w) => [
      base58.encode(w.secretKey),
      base58.encode(w.secretKey.slice(0, 32)),
    ]),
  ];
}

/** PKCS#8 header of an Ed25519 private key; the 32-byte seed follows (RFC 8410). */
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');

/** The address of a base58 secret key, by Node's Ed25519 from its 32-byte seed. */
function addressOfKey(secretKey: string): string {
  const seed = Buffer.from(base58.decode(secretKey).slice(0, 32));
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const spki = createPublicKey(key).export({ format: 'der', type: 'spki' });
  return base58.encode(spki.subarray(spki.length - 32));
}

interface PlainFile {
  readonly fleetName: string;
  readonly mnemonic: string;
  readonly wallets: readonly { readonly address: string; readonly secretKey: string }[];
}

describe('the backup folder writes, checks and then counts the wallets', () => {
  it('after addWallets: one write of each file, read back equal, wallets backed up', async () => {
    const s = await setup();
    const on = await enable(s);
    expect(on.state.kind).toBe('saved');
    expect(on.notBackedUp).toEqual([]);
    s.folder.writes.length = 0;

    const added = await call<VaultFileResult>(s.h, { type: 'addWallets', count: 2 });
    s.answers.push(added);
    expect(s.folder.writes.map((w) => w.name)).toEqual([KEYSTORE, PLAIN]);
    // The encrypted file is exactly what the worker answered.
    expect(s.folder.files.get(KEYSTORE)).toBe(added.fileText);
    // The plain file: the vault's phrase and, per wallet, a key that gives its address.
    const plain = JSON.parse(s.folder.files.get(PLAIN) ?? '') as PlainFile;
    expect(plain.mnemonic).toBe(MNEMONIC);
    expect(plain.wallets.map((w) => w.address)).toEqual(added.info.wallets.map((w) => w.address));
    for (const w of plain.wallets) expect(addressOfKey(w.secretKey)).toBe(w.address);
    const view = await call<BackupView>(s.h, { type: 'backupStatus' });
    expect(view).toEqual({
      state: { kind: 'saved', folder: 'Bunndly backups', at: new Date(T0).toISOString() },
      plain: true,
      notBackedUp: [],
    });
  });

  it('a failed write: the new wallets are not backed up, buy and arm refuse them', async () => {
    const s = await setup();
    await enable(s);
    s.folder.failWrites = true;
    await call(s.h, { type: 'addWallets', count: 2 });
    const view = await call<BackupView>(s.h, { type: 'backupStatus' });
    expect(view.state).toEqual({ kind: 'failed', folder: 'Bunndly backups', reason: 'write' });
    expect(view.notBackedUp).toEqual([2, 3]);
    const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    expect(await codeOf(s.h.handle({ type: 'startBuy', mint, wallets: [0, 2] }))).toBe(
      'WALLET_NOT_BACKED_UP',
    );
    expect(
      await codeOf(
        s.h.handle({
          type: 'arm',
          creator: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
          wallets: [3],
        }),
      ),
    ).toBe('WALLET_NOT_BACKED_UP');
    // The wallets backed up before keep working: the refusal is about 2 and 3 only.
    expect(await codeOf(s.h.handle({ type: 'startBuy', mint, wallets: [0, 1] }))).not.toBe(
      'WALLET_NOT_BACKED_UP',
    );
  });

  it('a read-back that differs: failed, and the wallets stay not backed up', async () => {
    const s = await setup();
    await enable(s);
    s.folder.corruptReads = true;
    await call(s.h, { type: 'addWallets', count: 1 });
    const view = await call<BackupView>(s.h, { type: 'backupStatus' });
    expect(view.state).toEqual({ kind: 'failed', folder: 'Bunndly backups', reason: 'verify' });
    expect(view.notBackedUp).toEqual([2]);
  });

  it('a wrong password turns nothing on and writes nothing', async () => {
    const s = await setup();
    expect(await codeOf(enable(s, 'not the password at all'))).toBe(
      'KEYSTORE_WRONG_PASSWORD_OR_CORRUPTED',
    );
    expect(s.store.dump()).toBeNull();
    expect(s.folder.writes).toEqual([]);
    expect((await call<BackupView>(s.h, { type: 'backupStatus' })).state.kind).toBe('off');
  });

  it('the handle outlives a restart; with access at prompt nothing is written before the click', async () => {
    const first = await setup();
    await enable(first);
    const fileText = first.folder.files.get(KEYSTORE) ?? '';
    const writes = first.folder.writes.length;

    // A new page: a new worker, the same store; the browser asks again.
    first.folder.permission = 'prompt';
    const h = createVaultHandler({ now: () => T0, backup: first.store });
    await call(h, { type: 'unlock', fileText, password: PASSWORD });
    const view = await call<BackupView>(h, { type: 'backupStatus' });
    expect(view.state).toEqual({ kind: 'reconnect', folder: 'Bunndly backups' });
    expect(first.folder.writes.length).toBe(writes);
    // Opened from disk: its wallets are in that file, so they still buy.
    expect(view.notBackedUp).toEqual([]);
    await call(h, { type: 'addWallets', count: 1 });
    expect(first.folder.writes.length).toBe(writes);
    expect((await call<BackupView>(h, { type: 'backupStatus' })).notBackedUp).toEqual([2]);

    // The page hands the handle back for the click; after it, a write.
    expect(await call(h, { type: 'backupHandle' })).toBe(first.folder);
    first.folder.permission = 'granted';
    const after = await call<BackupView>(h, { type: 'backupRetry' });
    expect(after.state.kind).toBe('saved');
    expect(after.notBackedUp).toEqual([]);
    expect(first.folder.writes.length).toBe(writes + 2);
  });

  it('files of the same name from another fleet stay; the copies get a suffix', async () => {
    const s = await setup();
    const other = await createKeystore({
      fleetName: FLEET,
      walletCount: 1,
      password: 'another long password 123',
    });
    const foreign = serializeKeystoreFile(other.file);
    const foreignPlain = '{"fleetName":"Kopia","wallets":[{"address":"x"}]}';
    s.folder.files.set(KEYSTORE, foreign);
    s.folder.files.set(PLAIN, foreignPlain);
    await enable(s);
    expect(s.folder.files.get(KEYSTORE)).toBe(foreign);
    expect(s.folder.files.get(PLAIN)).toBe(foreignPlain);
    expect(s.folder.writes.map((w) => w.name)).toEqual([
      `${FLEET}-2.keystore.json`,
      `${FLEET}-2${PLAIN_BACKUP_SUFFIX}`,
    ]);
    // The next change goes to the same suffixed files.
    await call(s.h, { type: 'addWallets', count: 1 });
    expect(s.folder.writes.slice(2).map((w) => w.name)).toEqual([
      `${FLEET}-2.keystore.json`,
      `${FLEET}-2${PLAIN_BACKUP_SUFFIX}`,
    ]);
  });

  it('the written file opens with the same password and gives the same addresses', async () => {
    const s = await setup();
    await enable(s);
    const h = createVaultHandler({ now: () => T0 });
    const status = await call<VaultStatus>(h, {
      type: 'unlock',
      fileText: s.folder.files.get(KEYSTORE),
      password: PASSWORD,
    });
    expect(status.info?.wallets.map((w) => w.address)).toEqual(
      s.created.info.wallets.map((w) => w.address),
    );
  });

  it('a locked vault writes nothing and keeps no folder', async () => {
    const s = await setup();
    await enable(s);
    const writes = s.folder.writes.length;
    await call(s.h, { type: 'lock' });
    expect(await codeOf(s.h.handle({ type: 'backupRetry' }))).toBe('VAULT_LOCKED');
    expect(await call(s.h, { type: 'backupHandle' })).toBeNull();
    expect((await call<BackupView>(s.h, { type: 'backupStatus' })).state.kind).toBe('off');
    expect(s.folder.writes.length).toBe(writes);
  });

  it('no phrase or key leaves the worker: answers, events, console, the store', async () => {
    const log = vi.spyOn(console, 'log');
    const warn = vi.spyOn(console, 'warn');
    const error = vi.spyOn(console, 'error');
    const s = await setup();
    await enable(s);
    s.answers.push(await call(s.h, { type: 'addWallets', count: 2 }));
    s.answers.push(await call(s.h, { type: 'backupStatus' }));
    const secrets = secretsOf(s.h);
    expect(secrets.length).toBe(9);
    // The plain file is in the folder: the phrase did go there, and only there.
    expect(s.folder.files.get(PLAIN)).toContain(MNEMONIC);
    const out = JSON.stringify(
      {
        answers: s.answers,
        events: s.events,
        store: s.store.dump(),
        console: [log.mock.calls, warn.mock.calls, error.mock.calls],
      },
      (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v),
    );
    for (const secret of secrets) expect(out).not.toContain(secret);
    expect(out).not.toContain('legal winner');
    // The store: the handle, the fleet's name and its id, nothing else.
    expect(s.store.dump()).toEqual({
      handle: '[handle Bunndly backups]',
      fleetName: FLEET,
      fileId: JSON.stringify([FLEET, s.created.info.createdAt]),
    });
  });
});

describe('the one switch for the plain file', () => {
  const fleet = async (): Promise<BackupFleet> => {
    const opened = await createKeystore({
      fleetName: FLEET,
      walletCount: 1,
      password: PASSWORD,
      mnemonic: MNEMONIC,
    });
    return {
      fileId: JSON.stringify([FLEET, opened.file.createdAt]),
      fleetName: FLEET,
      fileText: serializeKeystoreFile(opened.file),
      indices: [0],
      secrets: () => opened.secrets,
      alive: () => true,
    };
  };

  it('off: only the encrypted file goes to the folder', async () => {
    const folder = memoryFolder();
    const backup = createBackup({ store: memoryBackupStore(), now: () => T0, plain: false });
    const view = await backup.enable(await fleet(), folder);
    expect(folder.writes.map((w) => w.name)).toEqual([KEYSTORE]);
    expect(view.plain).toBe(false);
    expect(view.state.kind).toBe('saved');
  });

  it('a lock drops the folder from memory: no handle, nothing backed up for later', async () => {
    const folder = memoryFolder();
    const backup = createBackup({ store: memoryBackupStore(), now: () => T0 });
    const open = await fleet();
    await backup.enable(open, folder);
    backup.locked();
    expect(backup.handle()).toBeNull();
    expect(backup.view()).toEqual({ state: { kind: 'off' }, plain: true, notBackedUp: [] });
    await backup.changed(open);
    expect(folder.writes.map((w) => w.name)).toEqual([KEYSTORE, PLAIN]);
  });

  it('on: both files', async () => {
    const folder = memoryFolder();
    const backup = createBackup({ store: memoryBackupStore(), now: () => T0, plain: true });
    const view = await backup.enable(await fleet(), folder);
    expect(folder.writes.map((w) => w.name)).toEqual([KEYSTORE, PLAIN]);
    expect(view.plain).toBe(true);
  });
});
