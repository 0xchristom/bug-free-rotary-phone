import { base58, base64 } from '@scure/base';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AppError,
  DEFAULT_GLOBAL_SETTINGS,
  MAX_FLEET_SIZE,
  buildKeystore,
  defaultFleetSettings,
  encryptSecrets,
  openKeystore,
  secretsToJson,
  serializeKeystoreFile,
  parseKeystoreFile,
  type KeystoreFileV1,
} from '../../src/core/index.ts';
import type {
  VaultFileResult,
  VaultInfo,
  VaultPreview,
  VaultStatus,
} from '../../src/worker/protocol.ts';
import { createVaultHandler, type VaultHandler } from '../../src/worker/vault.ts';
import { valueWords } from '../helpers/words.ts';

// Real scrypt (N=2^17) on create/unlock and when re-opening files.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const PASSWORD = 'correct horse battery staple';
const MNEMONIC_12 = `${'abandon '.repeat(11)}about`;
const AUTO_LOCK_MS = 60_000;
const HELIUS_KEY = 'heliusApiKeyAbc123';
const JUPITER_KEY = 'jupiterApiKeyXyz789';
const RPC_URL = 'https://mainnet.helius-rpc.com/?api-key=customRpcKey42';
const WS_URL = 'wss://mainnet.helius-rpc.com/?api-key=customWsKey42';
/** API secrets that must never appear in a worker response (D-016). */
const API_SECRETS = [HELIUS_KEY, JUPITER_KEY, RPC_URL, WS_URL, 'customRpcKey42', 'customWsKey42'];

/** Every response the vault ever returned, for the leak scan at the end. */
const responses: unknown[] = [];
/** Secrets seen inside the vault (collected via inspect), never expected in responses. */
const secretsSeen = new Set<string>();

function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

async function call<T>(handler: VaultHandler, request: unknown): Promise<T> {
  const result = await handler.handle(request);
  responses.push(result);
  return result as T;
}

async function expectCode(promise: Promise<unknown>, code: AppError['code']): Promise<void> {
  const caught: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(caught).toBeInstanceOf(AppError);
  expect((caught as AppError).code).toBe(code);
}

/** Records the plaintext secrets currently held by the vault. */
function collectSecrets(handler: VaultHandler): void {
  const vault = handler.inspect().unlocked;
  if (!vault) return;
  secretsSeen.add(new TextDecoder().decode(vault.mnemonic));
  for (const w of vault.wallets) {
    secretsSeen.add(base58.encode(w.secretKey));
    secretsSeen.add(base58.encode(w.secretKey.slice(0, 32)));
  }
}

function heldBuffers(handler: VaultHandler): Uint8Array[] {
  const vault = handler.inspect().unlocked;
  if (!vault) throw new Error('vault is locked');
  return [vault.mnemonic, ...vault.wallets.map((w) => w.secretKey)];
}

function ivOf(fileText: string): string {
  return parseKeystoreFile(fileText).cipher.iv;
}

async function reopen(fileText: string): Promise<Awaited<ReturnType<typeof openKeystore>>> {
  return openKeystore(parseKeystoreFile(fileText), PASSWORD);
}

let main: VaultHandler;
let created: VaultFileResult;

beforeAll(async () => {
  main = createVaultHandler({ autoLockMs: AUTO_LOCK_MS });
  created = await call<VaultFileResult>(main, {
    type: 'create',
    fleetName: 'Flota',
    walletCount: 5,
    password: PASSWORD,
  });
  collectSecrets(main);
});

describe('create', () => {
  it('returns the encrypted file and public info only', async () => {
    const file = parseKeystoreFile(created.fileText);
    expect(file.public.wallets).toHaveLength(5);
    expect(created.info.wallets).toEqual(file.public.wallets);
    expect(created.info.fleetName).toBe('Flota');
    expect(Object.keys(created.info).sort()).toEqual([
      'apiKeys',
      'createdAt',
      'fleetName',
      'settings',
      'wallets',
    ]);
    const status = await call<VaultStatus>(main, { type: 'status' });
    expect(status).toMatchObject({ locked: false, armed: false });
    expect(status.info?.wallets).toHaveLength(5);
  });

  it('imports an existing mnemonic', async () => {
    const h = createVaultHandler();
    const res = await call<VaultFileResult>(h, {
      type: 'create',
      fleetName: 'Import',
      walletCount: 1,
      password: PASSWORD,
      mnemonic: MNEMONIC_12,
    });
    collectSecrets(h);
    expect(res.info.wallets[0]?.address).toBe('HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk');
  });

  it('keeps the vault locked when create fails', async () => {
    const h = createVaultHandler();
    await expectCode(
      h.handle({ type: 'create', fleetName: 'a/b', walletCount: 1, password: PASSWORD }),
      'INVALID_FLEET_NAME',
    );
    expect(h.inspect().unlocked).toBeNull();
  });
});

describe('saveSettings', () => {
  it('re-encrypts with the session key: same salt, new IV, opens with the password', async () => {
    const res = await call<VaultFileResult>(main, {
      type: 'saveSettings',
      settings: {
        ...defaultFleetSettings(),
        maxSpend: [
          { index: 0, lamports: 25_000_000n },
          { index: 4, lamports: 1n },
        ],
      },
      apiKeys: { helius: HELIUS_KEY, jupiter: JUPITER_KEY },
    });
    const before = parseKeystoreFile(created.fileText);
    const after = parseKeystoreFile(res.fileText);
    expect(after.cipher.iv).not.toBe(before.cipher.iv);
    expect(after.kdf).toEqual(before.kdf);
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.public).toEqual(before.public);
    expect(res.info.settings.maxSpend[0]?.lamports).toBe(25_000_000n);

    const opened = await reopen(res.fileText);
    expect(opened.secrets.settings.maxSpend).toEqual([
      { index: 0, lamports: 25_000_000n },
      { index: 4, lamports: 1n },
    ]);
    expect(opened.secrets.apiKeys).toEqual({ helius: HELIUS_KEY, jupiter: JUPITER_KEY });
    expect(res.info.apiKeys).toEqual({
      helius: true,
      jupiter: true,
      heliusRpcUrl: false,
      heliusWsUrl: false,
    });
  });

  it('rejects settings for wallets outside the fleet and keeps the old state', async () => {
    const before = (await call<VaultStatus>(main, { type: 'status' })).info?.settings;
    await expectCode(
      main.handle({
        type: 'saveSettings',
        settings: { ...defaultFleetSettings(), maxSpend: [{ index: 50, lamports: 1n }] },
        apiKeys: {},
      }),
      'INVALID_SETTINGS',
    );
    expect((await call<VaultStatus>(main, { type: 'status' })).info?.settings).toEqual(before);
  });
});

describe('addWallets', () => {
  it('appends the next indices; the file opens and the IV changes', async () => {
    const prev = await call<VaultFileResult>(main, {
      type: 'saveSettings',
      settings: defaultFleetSettings(),
    });
    const res = await call<VaultFileResult>(main, { type: 'addWallets', count: 3 });
    collectSecrets(main);
    expect(res.info.wallets.map((w) => w.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(res.info.wallets[7]?.label).toBe('W08');
    expect(ivOf(res.fileText)).not.toBe(ivOf(prev.fileText));
    const opened = await reopen(res.fileText);
    expect(opened.file.public.wallets.map((w) => w.address)).toEqual(
      res.info.wallets.map((w) => w.address),
    );
    // the first five addresses did not change
    expect(res.info.wallets.slice(0, 5)).toEqual(created.info.wallets);
  });

  it('grows to exactly 100 wallets and refuses more', async () => {
    const h = createVaultHandler();
    await call(h, { type: 'create', fleetName: 'Duza', walletCount: 98, password: PASSWORD });
    const full = await call<VaultFileResult>(h, { type: 'addWallets', count: 2 });
    collectSecrets(h);
    expect(full.info.wallets).toHaveLength(MAX_FLEET_SIZE);
    await expectCode(h.handle({ type: 'addWallets', count: 1 }), 'INVALID_DERIVATION_INDEX');
    await expectCode(h.handle({ type: 'addWallets', count: 0 }), 'INVALID_DERIVATION_INDEX');
    expect(h.inspect().unlocked?.wallets).toHaveLength(MAX_FLEET_SIZE);
    const opened = await reopen(full.fileText);
    expect(opened.secrets.wallets).toHaveLength(100);
  });

  it('runs concurrent requests one after another', async () => {
    const h = createVaultHandler();
    await call(h, { type: 'create', fleetName: 'Kolejka', walletCount: 1, password: PASSWORD });
    const [a, b] = await Promise.all([
      call<VaultFileResult>(h, { type: 'addWallets', count: 1 }),
      call<VaultFileResult>(h, { type: 'addWallets', count: 1 }),
    ]);
    collectSecrets(h);
    expect(a.info.wallets.map((w) => w.index)).toEqual([0, 1]);
    expect(b.info.wallets.map((w) => w.index)).toEqual([0, 1, 2]);
  });
});

describe('unlock', () => {
  let fileText: string;

  beforeAll(async () => {
    fileText = (await call<VaultFileResult>(main, { type: 'addWallets', count: 1 })).fileText;
    collectSecrets(main);
  });

  it('preview returns the public part without unlocking and is not activity', async () => {
    const c = clock();
    const h = createVaultHandler({ now: c.now, autoLockMs: AUTO_LOCK_MS });
    const before = h.inspect().lastActivity;
    c.advance(1_000);
    const preview = await call<VaultPreview>(h, { type: 'preview', fileText });
    const file = parseKeystoreFile(fileText);
    expect(preview).toEqual({
      fleetName: file.fleetName,
      createdAt: file.createdAt,
      wallets: file.public.wallets,
    });
    expect(Object.keys(preview).sort()).toEqual(['createdAt', 'fleetName', 'wallets']);
    expect(h.inspect().unlocked).toBeNull();
    expect(h.inspect().lastActivity).toBe(before);
  });

  it('preview rejects a broken file and does not touch an unlocked fleet', async () => {
    const h = createVaultHandler();
    await call<VaultStatus>(h, { type: 'unlock', fileText, password: PASSWORD });
    await expectCode(h.handle({ type: 'preview', fileText: 'nope' }), 'KEYSTORE_INVALID_FORMAT');
    await expectCode(h.handle({ type: 'preview', fileText: 42 }), 'INTERNAL_ERROR');
    expect(h.inspect().unlocked).not.toBeNull();
  });

  it('opens the file with the right password', async () => {
    const h = createVaultHandler();
    const status = await call<VaultStatus>(h, { type: 'unlock', fileText, password: PASSWORD });
    expect(status.locked).toBe(false);
    expect(status.info?.wallets).toEqual(parseKeystoreFile(fileText).public.wallets);
  });

  it('wrong password → KEYSTORE_WRONG_PASSWORD_OR_CORRUPTED, stays locked', async () => {
    const h = createVaultHandler();
    await expectCode(
      h.handle({ type: 'unlock', fileText, password: 'wrong password 123' }),
      'KEYSTORE_WRONG_PASSWORD_OR_CORRUPTED',
    );
    expect(h.inspect().unlocked).toBeNull();
  });

  it('a modified file is rejected', async () => {
    const h = createVaultHandler();
    const swapped = JSON.parse(fileText) as KeystoreFileV1 & {
      public: { wallets: { address: string }[] };
    };
    const [w0, w1] = swapped.public.wallets;
    if (!w0 || !w1) throw new Error('fixture');
    [w0.address, w1.address] = [w1.address, w0.address];
    await expectCode(
      h.handle({ type: 'unlock', fileText: JSON.stringify(swapped), password: PASSWORD }),
      'KEYSTORE_TAMPERED',
    );
    const flipped = JSON.parse(fileText) as { ciphertext: string };
    const bytes = base64.decode(flipped.ciphertext);
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    flipped.ciphertext = base64.encode(bytes);
    await expectCode(
      h.handle({ type: 'unlock', fileText: JSON.stringify(flipped), password: PASSWORD }),
      'KEYSTORE_WRONG_PASSWORD_OR_CORRUPTED',
    );
    await expectCode(
      h.handle({ type: 'unlock', fileText: '{', password: PASSWORD }),
      'KEYSTORE_INVALID_FORMAT',
    );
    expect(h.inspect().unlocked).toBeNull();
  });

  it('a failed unlock keeps an already unlocked fleet', async () => {
    await expectCode(
      main.handle({ type: 'unlock', fileText, password: 'wrong password 123' }),
      'KEYSTORE_WRONG_PASSWORD_OR_CORRUPTED',
    );
    expect(main.inspect().unlocked).not.toBeNull();
  });
});

describe('lock and auto-lock', () => {
  async function unlockedHandler(c: ReturnType<typeof clock>): Promise<VaultHandler> {
    const h = createVaultHandler({ now: c.now, autoLockMs: AUTO_LOCK_MS });
    await call(h, { type: 'unlock', fileText: created.fileText, password: PASSWORD });
    return h;
  }

  it('lock zeroes the secret buffers and key operations give VAULT_LOCKED', async () => {
    const h = await unlockedHandler(clock());
    const buffers = heldBuffers(h);
    expect(buffers.some((b) => b.some((x) => x !== 0))).toBe(true);
    const status = await call<VaultStatus>(h, { type: 'lock' });
    expect(status).toEqual({ locked: true, armed: false, info: null });
    expect(buffers.every((b) => b.every((x) => x === 0))).toBe(true);
    expect(h.inspect().unlocked).toBeNull();
    await expectCode(
      h.handle({ type: 'saveSettings', settings: { maxSpend: [] }, apiKeys: {} }),
      'VAULT_LOCKED',
    );
    await expectCode(h.handle({ type: 'addWallets', count: 1 }), 'VAULT_LOCKED');
  });

  it('auto-locks after the idle time; activity resets the timer', async () => {
    const c = clock();
    const h = await unlockedHandler(c);
    const buffers = heldBuffers(h);
    c.advance(AUTO_LOCK_MS - 1);
    expect(h.checkAutoLock()).toBe(false);
    await call(h, { type: 'activity' });
    c.advance(AUTO_LOCK_MS - 1);
    expect(h.checkAutoLock()).toBe(false);
    // status polling does not count as activity
    await call(h, { type: 'status' });
    c.advance(1);
    expect(h.checkAutoLock()).toBe(true);
    expect(buffers.every((b) => b.every((x) => x === 0))).toBe(true);
    await expectCode(h.handle({ type: 'addWallets', count: 1 }), 'VAULT_LOCKED');
  });

  it('locks on the next request even if the timer never fired', async () => {
    const c = clock();
    const h = await unlockedHandler(c);
    c.advance(AUTO_LOCK_MS);
    await expectCode(h.handle({ type: 'addWallets', count: 1 }), 'VAULT_LOCKED');
  });

  it('does not auto-lock while armed', async () => {
    const c = clock();
    const h = await unlockedHandler(c);
    await call(h, { type: 'setArmed', armed: true });
    for (let i = 0; i < 10; i++) {
      c.advance(AUTO_LOCK_MS * 10);
      expect(h.checkAutoLock()).toBe(false);
    }
    const status = await call<VaultStatus>(h, { type: 'status' });
    expect(status).toMatchObject({ locked: false, armed: true });
    await call(h, { type: 'setArmed', armed: false });
    c.advance(AUTO_LOCK_MS);
    expect(h.checkAutoLock()).toBe(true);
  });
});

describe('settings and write-only API keys (BUNNDLY-15)', () => {
  const custom = {
    ...DEFAULT_GLOBAL_SETTINGS,
    minReserveLamports: 20_000_000n,
    maxAttempts: 5,
    priceCeilingPercent: 120,
    noRouteWindowMs: 30_000,
    noRouteBackoffMinMs: 250,
    noRouteBackoffMaxMs: 4_000,
    mode: 'continuous' as const,
    explorer: 'orb' as const,
    autoLockMinutes: 30,
    jupiterPlan: 'custom' as const,
    orderRpm: 1_200,
  };

  async function fresh(): Promise<{ h: VaultHandler; fileText: string }> {
    const h = createVaultHandler();
    const res = await call<VaultFileResult>(h, {
      type: 'create',
      fleetName: 'Ustawienia',
      walletCount: 3,
      password: PASSWORD,
      mnemonic: MNEMONIC_12,
    });
    return { h, fileText: res.fileText };
  }

  it('global settings, maxSpend and active round-trip through the file', async () => {
    const { h } = await fresh();
    const settings = {
      global: custom,
      maxSpend: [{ index: 2, lamports: 7_000_000n }],
      active: [
        { index: 0, active: false },
        { index: 2, active: true },
      ],
    };
    const res = await call<VaultFileResult>(h, { type: 'saveSettings', settings });
    expect(res.info.settings).toEqual(settings);

    const other = createVaultHandler();
    const status = await call<VaultStatus>(other, {
      type: 'unlock',
      fileText: res.fileText,
      password: PASSWORD,
    });
    expect(status.info?.settings).toEqual(settings);
  });

  it('a file without the new fields (older core) opens with the defaults', async () => {
    const { fileText } = await fresh();
    const opened = await reopen(fileText);
    const legacy = JSON.parse(secretsToJson(opened.secrets)) as {
      settings: Record<string, unknown>;
    };
    legacy.settings = { maxSpend: [] };
    const encrypted = await encryptSecrets(
      new TextEncoder().encode(JSON.stringify(legacy)),
      PASSWORD,
    );
    const file = serializeKeystoreFile({ ...opened.file, ...encrypted });
    expect(file).not.toContain('global');

    const h = createVaultHandler();
    const status = await call<VaultStatus>(h, {
      type: 'unlock',
      fileText: file,
      password: PASSWORD,
    });
    expect(status.info?.settings).toEqual({
      maxSpend: [],
      active: [],
      global: DEFAULT_GLOBAL_SETTINGS,
    });
  });

  it('a missing key field keeps the key, null removes it, a string replaces it', async () => {
    const { h } = await fresh();
    const save = (apiKeys?: Record<string, string | null>): Promise<VaultFileResult> =>
      call<VaultFileResult>(h, {
        type: 'saveSettings',
        settings: defaultFleetSettings(),
        ...(apiKeys ? { apiKeys } : {}),
      });
    const keysIn = async (r: VaultFileResult): Promise<unknown> =>
      (await reopen(r.fileText)).secrets.apiKeys;

    let r = await save({ helius: HELIUS_KEY, jupiter: JUPITER_KEY, heliusRpcUrl: RPC_URL });
    expect(await keysIn(r)).toEqual({
      helius: HELIUS_KEY,
      jupiter: JUPITER_KEY,
      heliusRpcUrl: RPC_URL,
    });
    expect(r.info.apiKeys).toEqual({
      helius: true,
      jupiter: true,
      heliusRpcUrl: true,
      heliusWsUrl: false,
    });

    r = await save(); // no apiKeys at all
    expect(await keysIn(r)).toEqual({
      helius: HELIUS_KEY,
      jupiter: JUPITER_KEY,
      heliusRpcUrl: RPC_URL,
    });

    r = await save({ jupiter: null, heliusWsUrl: WS_URL }); // helius untouched
    expect(await keysIn(r)).toEqual({
      helius: HELIUS_KEY,
      heliusRpcUrl: RPC_URL,
      heliusWsUrl: WS_URL,
    });

    r = await save({ helius: 'newHeliusKey99' });
    expect(await keysIn(r)).toEqual({
      helius: 'newHeliusKey99',
      heliusRpcUrl: RPC_URL,
      heliusWsUrl: WS_URL,
    });
    expect(r.info.apiKeys).toEqual({
      helius: true,
      jupiter: false,
      heliusRpcUrl: true,
      heliusWsUrl: true,
    });
  });

  it.each<[string, unknown]>([
    [
      'price ceiling 0%',
      { ...defaultFleetSettings(), global: { ...custom, priceCeilingPercent: 0 } },
    ],
    ['11 attempts', { ...defaultFleetSettings(), global: { ...custom, maxAttempts: 11 } }],
    [
      'reserve as number',
      { ...defaultFleetSettings(), global: { ...custom, minReserveLamports: 15_000_000 } },
    ],
    [
      'plan rpm mismatch',
      { ...defaultFleetSettings(), global: { ...custom, jupiterPlan: 'pro', orderRpm: 60 } },
    ],
    ['unknown explorer', { ...defaultFleetSettings(), global: { ...custom, explorer: 'x' } }],
    [
      'active for a missing wallet',
      { ...defaultFleetSettings(), active: [{ index: 9, active: true }] },
    ],
    ['lamports as number', { ...defaultFleetSettings(), maxSpend: [{ index: 0, lamports: 5 }] }],
    ['no global', { maxSpend: [], active: [] }],
  ])('invalid settings (%s) → INVALID_SETTINGS, nothing changes', async (_label, settings) => {
    const { h } = await fresh();
    const before = (await call<VaultStatus>(h, { type: 'status' })).info;
    await expectCode(h.handle({ type: 'saveSettings', settings }), 'INVALID_SETTINGS');
    expect((await call<VaultStatus>(h, { type: 'status' })).info).toEqual(before);
  });

  it.each<[string, unknown]>([
    ['empty key', { helius: '' }],
    ['key with a space', { jupiter: 'a b' }],
    ['http RPC URL', { heliusRpcUrl: 'http://rpc.example.com/?api-key=x' }],
    ['https WS URL', { heliusWsUrl: 'https://mainnet.helius-rpc.com' }],
    ['unknown key', { other: 'x' }],
    ['number', { helius: 5 }],
  ])('invalid key change (%s) → INVALID_SETTINGS', async (_label, apiKeys) => {
    const { h } = await fresh();
    await expectCode(
      h.handle({ type: 'saveSettings', settings: defaultFleetSettings(), apiKeys }),
      'INVALID_SETTINGS',
    );
  });

  it('auto-lock follows the autoLockMinutes setting', async () => {
    const c = clock();
    const h = createVaultHandler({ now: c.now });
    await call(h, { type: 'create', fleetName: 'Zegar', walletCount: 1, password: PASSWORD });
    const settings = {
      ...defaultFleetSettings(),
      global: { ...DEFAULT_GLOBAL_SETTINGS, autoLockMinutes: 2 },
    };
    await call(h, { type: 'saveSettings', settings });
    c.advance(2 * 60_000 - 1);
    expect(h.checkAutoLock()).toBe(false);
    c.advance(1);
    expect(h.checkAutoLock()).toBe(true);
  });

  it('a reset setting is reported in VaultInfo until the next save', async () => {
    const { fileText } = await fresh();
    const opened = await reopen(fileText);
    const json = JSON.parse(secretsToJson(opened.secrets)) as {
      settings: { global: Record<string, unknown> };
    };
    json.settings.global.minReserveLamports = '1000000'; // 0.001 SOL, now below the floor
    const encrypted = await encryptSecrets(
      new TextEncoder().encode(JSON.stringify(json)),
      PASSWORD,
    );
    const h = createVaultHandler();
    const status = await call<VaultStatus>(h, {
      type: 'unlock',
      fileText: serializeKeystoreFile({ ...opened.file, ...encrypted }),
      password: PASSWORD,
    });
    expect(status.info?.settings.resetFields).toEqual(['minReserveLamports']);
    expect(status.info?.settings.global).toEqual(DEFAULT_GLOBAL_SETTINGS);
    // saving 0.001 again is refused with the new floor
    await expectCode(
      h.handle({
        type: 'saveSettings',
        settings: {
          ...defaultFleetSettings(),
          global: { ...DEFAULT_GLOBAL_SETTINGS, minReserveLamports: 1_000_000n },
        },
      }),
      'INVALID_SETTINGS',
    );
    const res = await call<VaultFileResult>(h, {
      type: 'saveSettings',
      settings: defaultFleetSettings(),
    });
    expect('resetFields' in res.info.settings).toBe(false);
    expect((await reopen(res.fileText)).secrets.settings.resetFields).toBeUndefined();
  });

  it('VaultInfo carries only flags for API keys', async () => {
    const { h } = await fresh();
    await call(h, {
      type: 'saveSettings',
      settings: defaultFleetSettings(),
      apiKeys: {
        helius: HELIUS_KEY,
        jupiter: JUPITER_KEY,
        heliusRpcUrl: RPC_URL,
        heliusWsUrl: WS_URL,
      },
    });
    const info = (await call<VaultStatus>(h, { type: 'status' })).info as VaultInfo;
    expect(info.apiKeys).toEqual({
      helius: true,
      jupiter: true,
      heliusRpcUrl: true,
      heliusWsUrl: true,
    });
    // every later response of this handler is scanned by "no secrets in any response"
    await call(h, { type: 'addWallets', count: 1 });
    await call(h, { type: 'activity' });
    await call(h, { type: 'setArmed', armed: false });
    await call(h, { type: 'lock' });
    const reopened = await call<VaultFileResult>(createVaultHandler(), {
      type: 'unlock',
      fileText: (await buildFileWithKeys()).text,
      password: PASSWORD,
    });
    expect(reopened).toBeTruthy();
  });

  async function buildFileWithKeys(): Promise<{ text: string }> {
    const opened = await reopen((await fresh()).fileText);
    const file = await buildKeystore(
      {
        ...opened.secrets,
        apiKeys: {
          helius: HELIUS_KEY,
          jupiter: JUPITER_KEY,
          heliusRpcUrl: RPC_URL,
          heliusWsUrl: WS_URL,
        },
      },
      { fleetName: opened.file.fleetName },
      PASSWORD,
    );
    return { text: serializeKeystoreFile(file) };
  }
});

describe('request validation', () => {
  it.each([
    ['null', null],
    ['unknown type', { type: 'signBytes', bytes: [1, 2, 3] }],
    ['exportKeys', { type: 'exportKeys' }],
    ['count as string', { type: 'addWallets', count: '3' }],
    ['armed as string', { type: 'setArmed', armed: 'yes' }],
    ['password as number', { type: 'unlock', fileText: '{}', password: 1 }],
  ])('%s → INTERNAL_ERROR', async (_label, request) => {
    await expectCode(main.handle(request), 'INTERNAL_ERROR');
  });
});

describe('no secrets in any response', () => {
  it('serialized responses of all operations contain no mnemonic or private key', () => {
    expect(responses.length).toBeGreaterThan(20);
    expect(secretsSeen.size).toBeGreaterThan(100);
    const text = JSON.stringify(responses, (_k, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    for (const secret of secretsSeen) {
      expect(text).not.toContain(secret);
    }
    // API keys never leave the worker (D-016); fileText is encrypted, so scan it too.
    for (const key of API_SECRETS) expect(text).not.toContain(key);
    // Mnemonic words in any string value outside the encrypted file text.
    // Addresses are skipped: base58 fragments can be BIP39 words by chance (e.g. "van");
    // keys are covered by the exact-match check above.
    // `global` holds fixed setting names ("free", "custom", …) that are BIP39 words too.
    const words = valueWords(responses, ['fileText', 'address', 'global']);
    for (const secret of secretsSeen) {
      if (!secret.includes(' ')) continue;
      for (const word of new Set(secret.split(' '))) {
        expect(words.has(word)).toBe(false);
      }
    }
  });
});
