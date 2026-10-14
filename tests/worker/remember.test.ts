/**
 * The fleet remembered on this device and the passwordless window (BUNNDLY-52, D-051),
 * through the real vault handler. The store is an in-memory stand-in that clones like
 * IndexedDB (tests/helpers/remember-store.ts).
 */
import { base58 } from '@scure/base';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AppError,
  createKeystore,
  serializeKeystoreFile,
  type PublicWalletV1,
} from '../../src/core/index.ts';
import type { RememberedView, VaultFileResult, VaultStatus } from '../../src/worker/protocol.ts';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import {
  sealSession,
  sessionValid,
  type RememberStore,
  type SessionRecord,
} from '../../src/worker/remember.ts';
import { createVaultHandler, type VaultHandler } from '../../src/worker/vault.ts';
import {
  failingRememberStore,
  memoryRememberStore,
  type MemoryRememberStore,
} from '../helpers/remember-store.ts';
import { valueWords } from '../helpers/words.ts';

const kdf = vi.hoisted(() => ({ calls: 0 }));
vi.mock('@noble/hashes/scrypt.js', async () => {
  const fast = await import('../helpers/fast-kdf.ts');
  return {
    scryptAsync: (...args: Parameters<typeof fast.scryptAsync>) => {
      kdf.calls += 1;
      return fast.scryptAsync(...args);
    },
  };
});

const PASSWORD = 'zielony Kot, 7 krzeseł; drabina';
const MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const HELIUS_KEY = 'heliusApiKeyAbc123';
const MINUTE = 60_000;
const T0 = 1_790_000_000_000;

let t = T0;
const now = (): number => t;

function vault(store: RememberStore | null, autoLockMs = 10 * MINUTE): VaultHandler {
  return createVaultHandler({ now, remember: store, autoLockMs });
}

async function call<T>(h: VaultHandler, request: unknown): Promise<T> {
  return (await h.handle(request)) as T;
}

async function expectCode(promise: Promise<unknown>, code: AppError['code']): Promise<void> {
  const caught: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(caught).toBeInstanceOf(AppError);
  expect((caught as AppError).code).toBe(code);
}

function create(h: VaultHandler, remember?: boolean, fleetName = 'Device fleet') {
  return call<VaultFileResult>(h, {
    type: 'create',
    fleetName,
    walletCount: 3,
    password: PASSWORD,
    mnemonic: MNEMONIC,
    ...(remember === undefined ? {} : { remember }),
  });
}

const addresses = (wallets: readonly PublicWalletV1[] | undefined): string[] =>
  (wallets ?? []).map((w) => w.address);

async function session(store: MemoryRememberStore): Promise<SessionRecord | undefined> {
  return store.get('session');
}

beforeEach(() => {
  t = T0;
  kdf.calls = 0;
});

/** Every byte of the stored records: strings as UTF-8, byte arrays as they are. */
function storedBytes(value: unknown): Uint8Array[] {
  const out: Uint8Array[] = [];
  const visit = (v: unknown): void => {
    if (typeof v === 'string') out.push(new TextEncoder().encode(v));
    else if (v instanceof Uint8Array) out.push(v);
    else if (v instanceof CryptoKey)
      return; // cannot be read, by design
    else if (Array.isArray(v)) v.forEach(visit);
    else if (typeof v === 'object' && v !== null) Object.values(v).forEach(visit);
  };
  visit(value);
  return out;
}

function containsBytes(haystacks: readonly Uint8Array[], needle: Uint8Array): boolean {
  return haystacks.some((h) => {
    outer: for (let i = 0; i + needle.length <= h.length; i++) {
      for (let j = 0; j < needle.length; j++) if (h[i + j] !== needle[j]) continue outer;
      return true;
    }
    return false;
  });
}

describe('remembered fleet: what is stored', () => {
  it('create with remember keeps exactly the file to save, and no secret anywhere', async () => {
    const store = memoryRememberStore();
    const h = vault(store);
    const created = await create(h, true);
    // An API key in the fleet: it must not leak either.
    const saved = await call<VaultFileResult>(h, {
      type: 'saveSettings',
      settings: created.info.settings,
      apiKeys: { helius: HELIUS_KEY },
    });

    expect(store.keys()).toEqual(['account', 'prefs', 'session']);
    const account = await store.get('account');
    // Byte for byte the file the screen offers to save (the latest one).
    expect(account?.fileText).toBe(saved.fileText);

    const unlocked = h.inspect().unlocked;
    if (unlocked === null) throw new Error('not unlocked');
    const dump = store.dump();
    const bytes = storedBytes(dump);
    const text = bytes.map((b) => new TextDecoder().decode(b)).join('\n');
    // Password, API key, mnemonic: neither as text nor as bytes.
    for (const secret of [PASSWORD, HELIUS_KEY, MNEMONIC]) {
      expect(text).not.toContain(secret);
      expect(containsBytes(bytes, new TextEncoder().encode(secret))).toBe(false);
    }
    // No mnemonic word among the stored values (base64 fields are checked as bytes above).
    const words = valueWords(
      { ...dump, account: JSON.parse(account?.fileText ?? '{}') as unknown },
      ['ciphertext', 'salt', 'iv', 'address', 'tag'],
    );
    for (const word of new Set(MNEMONIC.split(' '))) expect(words.has(word)).toBe(false);
    // No private key of any wallet: 64-byte secret, its 32-byte seed, base58 of both.
    expect(unlocked.wallets).toHaveLength(3);
    for (const w of unlocked.wallets) {
      expect(containsBytes(bytes, w.secretKey)).toBe(false);
      expect(containsBytes(bytes, w.secretKey.slice(0, 32))).toBe(false);
      expect(text).not.toContain(base58.encode(w.secretKey));
      expect(text).not.toContain(base58.encode(w.secretKey.slice(0, 32)));
    }
  });

  it('the key in the session record cannot be exported and only encrypts and decrypts', async () => {
    const store = memoryRememberStore();
    await create(vault(store), true);
    const record = await session(store);
    if (record === undefined) throw new Error('no session record');
    expect(record.key).toBeInstanceOf(CryptoKey);
    expect(record.key.extractable).toBe(false);
    expect([...record.key.usages].sort()).toEqual(['decrypt', 'encrypt']);
    await expect(crypto.subtle.exportKey('raw', record.key)).rejects.toThrow();
  });

  it('with remember off no fleet data is kept on any path', async () => {
    const store = memoryRememberStore();
    const h = vault(store);
    const created = await create(h, false);
    expect(store.keys()).toEqual(['prefs']);
    await call(h, { type: 'saveSettings', settings: created.info.settings, apiKeys: {} });
    await call(h, { type: 'addWallets', count: 1 });
    await call(h, { type: 'lock' });
    await call(h, {
      type: 'unlock',
      fileText: created.fileText,
      password: PASSWORD,
      remember: false,
    });
    expect(store.keys()).toEqual(['prefs']);
    expect(await store.get('prefs')).toEqual({ remember: false, windowMs: 15 * MINUTE });
  });

  it('opening with remember off forgets a fleet remembered before', async () => {
    const store = memoryRememberStore();
    const h = vault(store);
    const created = await create(h, true);
    expect(store.keys()).toEqual(['account', 'prefs', 'session']);
    await call(h, { type: 'lock' });
    await call(h, {
      type: 'unlock',
      fileText: created.fileText,
      password: PASSWORD,
      remember: false,
    });
    expect(store.keys()).toEqual(['prefs']);
  });

  it('saved settings and added wallets reach the remembered copy', async () => {
    const store = memoryRememberStore();
    const h = vault(store);
    const created = await create(h, true);
    await call(h, {
      type: 'saveSettings',
      settings: { ...created.info.settings, maxSpend: [{ index: 1, lamports: 250_000_000n }] },
      apiKeys: {},
    });
    const added = await call<VaultFileResult>(h, { type: 'addWallets', count: 2 });
    expect((await store.get('account'))?.fileText).toBe(added.fileText);

    const next = vault(store);
    const resumed = await call<VaultStatus>(next, { type: 'resume' });
    expect(resumed.info?.wallets).toHaveLength(5);
    expect(resumed.info?.settings.maxSpend).toEqual([{ index: 1, lamports: 250_000_000n }]);
  });

  it('the view tells the UI the fleet name, the wallet count and whether the disk lags', async () => {
    const store = memoryRememberStore();
    await create(vault(store), true);
    const view = await call<RememberedView>(vault(store), { type: 'remembered' });
    expect(view).toEqual({
      available: true,
      account: {
        fleetName: 'Device fleet',
        createdAt: expect.any(String) as string,
        walletCount: 3,
        unsaved: true, // a new fleet: its file was never written
      },
      prefs: { remember: true, windowMs: 15 * MINUTE },
    });
  });
});

// BUNNDLY-80: the browser may hold the only copy; a reload must still know it.
describe('remembered fleet: a file the disk lacks', () => {
  type Pending = { fileText: string; fleetName: string } | null;
  const pendingOf = (h: VaultHandler) => call<Pending>(h, { type: 'pendingFile' });
  const viewUnsaved = async (h: VaultHandler) =>
    (await call<RememberedView>(h, { type: 'remembered' })).account?.unsaved;

  it('a new fleet is pending until its text is saved; a reload in between still says so', async () => {
    const store = memoryRememberStore();
    const h = vault(store);
    const created = await create(h, true);
    expect(await pendingOf(h)).toEqual({ fileText: created.fileText, fleetName: 'Device fleet' });

    const reloaded = vault(store);
    await call(reloaded, { type: 'resume' });
    expect(await pendingOf(reloaded)).toEqual({
      fileText: created.fileText,
      fleetName: 'Device fleet',
    });
    expect(await viewUnsaved(reloaded)).toBe(true);

    expect(await call<Pending>(reloaded, { type: 'fileSaved', fileText: created.fileText })).toBe(
      null,
    );
    expect((await store.get('account'))?.unsaved).toBe(false);
    const again = vault(store);
    await call(again, { type: 'resume' });
    expect(await pendingOf(again)).toBeNull();
  });

  it('a change after the save is pending again; saving the older text does not clear it', async () => {
    const store = memoryRememberStore();
    const h = vault(store);
    const created = await create(h, true);
    await call(h, { type: 'fileSaved', fileText: created.fileText });
    expect(await pendingOf(h)).toBeNull();

    const changed = await call<VaultFileResult>(h, {
      type: 'saveSettings',
      settings: { ...created.info.settings, maxSpend: [{ index: 0, lamports: 100_000_000n }] },
      apiKeys: {},
    });
    expect((await pendingOf(h))?.fileText).toBe(changed.fileText);
    expect((await store.get('account'))?.unsaved).toBe(true);

    // The old file written again (e.g. a second click on an old button): still behind.
    expect(await call<Pending>(h, { type: 'fileSaved', fileText: created.fileText })).toEqual({
      fileText: changed.fileText,
      fleetName: 'Device fleet',
    });
    expect((await store.get('account'))?.unsaved).toBe(true);
  });

  it('unlocking the remembered fleet with the password keeps the mark', async () => {
    const store = memoryRememberStore();
    const created = await create(vault(store), true);
    const h = vault(store);
    await call(h, { type: 'unlockRemembered', password: PASSWORD });
    expect((await pendingOf(h))?.fileText).toBe(created.fileText);
    expect((await store.get('account'))?.unsaved).toBe(true);
  });

  it('opened from a file on disk: nothing is pending, and the record says so', async () => {
    const store = memoryRememberStore();
    const created = await create(vault(null), undefined);
    const h = vault(store);
    await call(h, {
      type: 'unlock',
      fileText: created.fileText,
      password: PASSWORD,
      remember: true,
    });
    expect(await pendingOf(h)).toBeNull();
    expect((await store.get('account'))?.unsaved).toBe(false);
  });

  it('a wizard file written after a lock still clears the record', async () => {
    const store = memoryRememberStore();
    const h = vault(store);
    const created = await create(h, true);
    await call(h, { type: 'lock' });
    expect(await pendingOf(h)).toBeNull(); // locked: nothing to offer
    await call(h, { type: 'fileSaved', fileText: created.fileText });
    expect((await store.get('account'))?.unsaved).toBe(false);
  });

  it('a record from before the mark reads as saved', async () => {
    const store = memoryRememberStore();
    await create(vault(store), true);
    const account = await store.get('account');
    if (account === undefined) throw new Error('no account record');
    await store.put('account', { fileText: account.fileText, fileId: account.fileId });
    const h = vault(store);
    await call(h, { type: 'resume' });
    expect(await pendingOf(h)).toBeNull();
    expect(await viewUnsaved(h)).toBe(false);
  });

  it('turning remember on for a fleet opened from disk does not mark it unsaved', async () => {
    const store = memoryRememberStore();
    const created = await create(vault(null), undefined);
    const h = vault(store);
    await call(h, { type: 'unlock', fileText: created.fileText, password: PASSWORD });
    await call(h, { type: 'setRemember', remember: true, windowMs: 15 * MINUTE });
    expect(await pendingOf(h)).toBeNull();
    expect((await store.get('account'))?.unsaved).toBe(false);
  });
});

describe('passwordless window', () => {
  it('a new session within the window opens the fleet without the password and without scrypt', async () => {
    const store = memoryRememberStore();
    const created = await create(vault(store), true);
    expect((await session(store))?.expiresAt).toBe(T0 + 15 * MINUTE);

    t += 14 * MINUTE; // a page refresh 14 minutes later
    kdf.calls = 0;
    const next = vault(store);
    const resumed = await call<VaultStatus>(next, { type: 'resume' });
    expect(resumed.locked).toBe(false);
    expect(addresses(resumed.info?.wallets)).toEqual(addresses(created.info.wallets));
    expect(kdf.calls).toBe(0);
    // The window starts again from the refresh.
    expect((await session(store))?.expiresAt).toBe(t + 15 * MINUTE);
  });

  it('the window counts from the last activity, like the auto-lock', async () => {
    const store = memoryRememberStore();
    const h = vault(store, 15 * MINUTE);
    const created = await create(h, true);
    t += 10 * MINUTE;
    await call(h, { type: 'activity' });
    await call(h, { type: 'remembered' }); // queued after the rewrite
    expect((await session(store))?.expiresAt).toBe(T0 + 25 * MINUTE);
    t += 10 * MINUTE;
    await call(h, { type: 'activity' });
    await call(h, { type: 'remembered' });
    expect((await session(store))?.expiresAt).toBe(T0 + 35 * MINUTE);
    t += 30_000; // within a minute of the last write: no new write
    await call(h, { type: 'activity' });
    await call(h, { type: 'remembered' });
    expect((await session(store))?.expiresAt).toBe(T0 + 35 * MINUTE);

    t = T0 + 30 * MINUTE; // a refresh 30 minutes after the unlock, 10 after the last activity
    kdf.calls = 0;
    const resumed = await call<VaultStatus>(vault(store), { type: 'resume' });
    expect(resumed.locked).toBe(false);
    expect(addresses(resumed.info?.wallets)).toEqual(addresses(created.info.wallets));
    expect(kdf.calls).toBe(0);
  });

  it('16 minutes without activity in a 15-minute window: the password is needed', async () => {
    const store = memoryRememberStore();
    const h = vault(store, 15 * MINUTE);
    await create(h, true);
    t += 10 * MINUTE;
    await call(h, { type: 'activity' });
    await call(h, { type: 'remembered' });
    t += 16 * MINUTE;
    const resumed = await call<VaultStatus>(vault(store), { type: 'resume' });
    expect(resumed.locked).toBe(true);
    expect(await session(store)).toBeUndefined();
  });

  it('after the window the password is needed and the record is gone', async () => {
    const store = memoryRememberStore();
    await create(vault(store), true);
    t += 15 * MINUTE; // exactly at the end
    const resumed = await call<VaultStatus>(vault(store), { type: 'resume' });
    expect(resumed.locked).toBe(true);
    expect(await session(store)).toBeUndefined();
    expect(store.keys()).toEqual(['account', 'prefs']); // the fleet stays remembered
  });

  it('a changed expiry is refused by the tag (AAD) and removes the record', async () => {
    const store = memoryRememberStore();
    await create(vault(store), true);
    const record = await session(store);
    if (record === undefined) throw new Error('no session record');
    await store.put('session', {
      ...record,
      expiresAt: record.expiresAt === null ? 1 : record.expiresAt + 60 * MINUTE,
    });
    t += 20 * MINUTE; // past the real end, inside the forged one
    const resumed = await call<VaultStatus>(vault(store), { type: 'resume' });
    expect(resumed.locked).toBe(true);
    expect(await session(store)).toBeUndefined();
  });

  it('a record sealed for another file id is refused by the tag (AAD) and removed', async () => {
    const store = memoryRememberStore();
    await create(vault(store), true);
    const record = await session(store);
    if (record === undefined) throw new Error('no session record');
    // Same key and expiry, tag made for another file; only the AAD can tell.
    const otherId = JSON.stringify(['Other fleet', '2026-01-01T00:00:00.000Z']);
    const forged = await sealSession(record.key, otherId, record.expiresAt);
    await store.put('session', { ...forged, fileId: record.fileId });
    const resumed = await call<VaultStatus>(vault(store), { type: 'resume' });
    expect(resumed.locked).toBe(true);
    expect(await session(store)).toBeUndefined();
  });

  it('the same key, but extractable, with a valid tag: refused, removed, the password is needed', async () => {
    const store = memoryRememberStore();
    const created = await create(vault(store), true);
    const record = await session(store);
    if (record === undefined) throw new Error('no session record');
    // The file key rebuilt apart from the vault: scrypt (the test stand-in) over the
    // password and the file's salt and cost, imported as extractable this time.
    const file = JSON.parse(created.fileText) as {
      kdf: { N: number; r: number; p: number; salt: string };
    };
    const salt = Uint8Array.from(atob(file.kdf.salt), (c) => c.charCodeAt(0));
    const bytes = await scryptAsync(new TextEncoder().encode(PASSWORD.normalize('NFKC')), salt, {
      N: file.kdf.N,
      r: file.kdf.r,
      p: file.kdf.p,
      dkLen: 32,
    });
    const extractable = await crypto.subtle.importKey(
      'raw',
      new Uint8Array(bytes),
      'AES-GCM',
      true,
      ['encrypt', 'decrypt'],
    );
    const forged = await sealSession(extractable, record.fileId, record.expiresAt);
    // It is the file's key: the record's own key checks the forged tag.
    expect(await sessionValid({ ...forged, key: record.key }, record.fileId, t)).toBe(true);
    await store.put('session', forged);

    const h = vault(store);
    const resumed = await call<VaultStatus>(h, { type: 'resume' });
    expect(resumed.locked).toBe(true);
    expect(await session(store)).toBeUndefined();
    const opened = await call<VaultStatus>(h, { type: 'unlockRemembered', password: PASSWORD });
    expect(addresses(opened.info?.wallets)).toEqual(addresses(created.info.wallets));
  });

  it('Lock removes the record: the next visit needs the password', async () => {
    const store = memoryRememberStore();
    const h = vault(store);
    await create(h, true);
    t += 5 * MINUTE; // Lock is activity too: the window rewrite it queues must not run
    await call(h, { type: 'lock' });
    await call(h, { type: 'remembered' }); // queued after anything Lock queued
    expect(await session(store)).toBeUndefined();
    const resumed = await call<VaultStatus>(vault(store), { type: 'resume' });
    expect(resumed.locked).toBe(true);
  });

  it('auto-lock removes a timed window (timer and next request)', async () => {
    const store = memoryRememberStore();
    const h = vault(store);
    await create(h, true);
    t += 10 * MINUTE;
    expect(h.checkAutoLock()).toBe(true);
    await call(h, { type: 'remembered' }); // queued after the removal
    expect(await session(store)).toBeUndefined();

    const h2 = vault(store);
    await call(h2, { type: 'unlockRemembered', password: PASSWORD });
    expect(await session(store)).toBeDefined();
    t += 10 * MINUTE;
    await call(h2, { type: 'status' }); // auto-lock noticed inside a request
    expect(await session(store)).toBeUndefined();
  });

  it('a window without a limit survives auto-lock and days, until Lock', async () => {
    const store = memoryRememberStore();
    const h = vault(store);
    const created = await create(h, true);
    await call(h, { type: 'setRemember', remember: true, windowMs: null });
    expect((await session(store))?.expiresAt).toBeNull();
    t += 10 * MINUTE;
    expect(h.checkAutoLock()).toBe(true);
    await call(h, { type: 'remembered' });
    expect(h.inspect().unlocked).toBeNull(); // the keys left the worker's memory
    expect((await session(store))?.expiresAt).toBeNull(); // the record stays

    t += 30 * 24 * 60 * MINUTE;
    const next = vault(store);
    const resumed = await call<VaultStatus>(next, { type: 'resume' });
    expect(addresses(resumed.info?.wallets)).toEqual(addresses(created.info.wallets));
    await call(next, { type: 'lock' });
    expect(await session(store)).toBeUndefined();
  });

  it('a shorter window chosen while unlocked applies from now', async () => {
    const store = memoryRememberStore();
    const h = vault(store);
    await create(h, true);
    t += 5 * MINUTE;
    await call(h, { type: 'setRemember', remember: true, windowMs: 120 * MINUTE });
    expect((await session(store))?.expiresAt).toBe(t + 120 * MINUTE);
    await expectCode(
      h.handle({ type: 'setRemember', remember: true, windowMs: 7 * MINUTE }),
      'INTERNAL_ERROR',
    );
  });

  it('opening another file (no Lock in between) removes the window of the first', async () => {
    const other = serializeKeystoreFile(
      (await createKeystore({ fleetName: 'Other fleet', walletCount: 1, password: PASSWORD })).file,
    );
    const store = memoryRememberStore();
    const h = vault(store);
    await create(h, true);
    const firstId = (await session(store))?.fileId;
    expect(firstId).toBeDefined();
    // Device left as it is: the first file's window must still go.
    await call(h, { type: 'unlock', fileText: other, password: PASSWORD });
    expect(await session(store)).toBeUndefined();

    // Remembering the other file replaces the first one's records.
    await create(h, true);
    await call(h, { type: 'unlock', fileText: other, password: PASSWORD, remember: true });
    const record = await session(store);
    expect(record?.fileId).toBe((await store.get('account'))?.fileId);
    expect(record?.fileId).not.toBe(firstId);
  });

  it('Forget this device removes the fleet and the window', async () => {
    const store = memoryRememberStore();
    const h = vault(store);
    await create(h, true);
    const view = await call<RememberedView>(h, { type: 'forget' });
    expect(view.account).toBeNull();
    expect(store.keys()).toEqual(['prefs']);
    const resumed = await call<VaultStatus>(vault(store), { type: 'resume' });
    expect(resumed.locked).toBe(true);
  });
});

describe('unlocking the remembered fleet with the password', () => {
  it('the right password opens it; a wrong one fails and changes nothing stored', async () => {
    const store = memoryRememberStore();
    const h = vault(store);
    const created = await create(h, true);
    await call(h, { type: 'lock' });
    expect(store.keys()).toEqual(['account', 'prefs']);
    const before = JSON.stringify(storedBytes(store.dump()).map((b) => Array.from(b)));

    await expectCode(
      h.handle({ type: 'unlockRemembered', password: 'not the password at all' }),
      'KEYSTORE_WRONG_PASSWORD_OR_CORRUPTED',
    );
    expect(JSON.stringify(storedBytes(store.dump()).map((b) => Array.from(b)))).toBe(before);

    const opened = await call<VaultStatus>(h, { type: 'unlockRemembered', password: PASSWORD });
    expect(addresses(opened.info?.wallets)).toEqual(addresses(created.info.wallets));
    expect(await session(store)).toBeDefined();
  });

  it('without a remembered fleet it says so', async () => {
    await expectCode(
      vault(memoryRememberStore()).handle({ type: 'unlockRemembered', password: PASSWORD }),
      'NO_REMEMBERED_FLEET',
    );
  });
});

describe('a browser without IndexedDB', () => {
  it('a refusing store: no crash, the option is unavailable, the fleet still opens', async () => {
    const h = vault(failingRememberStore());
    const created = await create(h, true);
    expect(created.info.wallets).toHaveLength(3);
    const view = await call<RememberedView>(h, { type: 'remembered' });
    expect(view.available).toBe(false);
    expect(view.account).toBeNull();
    await expectCode(
      h.handle({ type: 'setRemember', remember: true, windowMs: 15 * MINUTE }),
      'REMEMBER_UNAVAILABLE',
    );
    expect((await call<VaultStatus>(h, { type: 'resume' })).locked).toBe(false);
  });

  it('no store at all: unavailable, resume leaves the vault locked', async () => {
    const h = vault(null);
    expect((await call<RememberedView>(h, { type: 'remembered' })).available).toBe(false);
    expect((await call<VaultStatus>(h, { type: 'resume' })).locked).toBe(true);
  });
});
