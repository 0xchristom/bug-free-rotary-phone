import { base58 } from '@scure/base';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  AppError,
  MAX_KEYSTORE_FILE_BYTES,
  buildKeystore,
  createKeystore,
  defaultWalletLabel,
  deriveWallets,
  isValidFleetName,
  openKeystore,
  parseKeystoreFile,
  parseSecrets,
  secretsToJson,
  serializeKeystoreFile,
  solanaDerivationPath,
  type KeystoreFileV1,
  type KeystoreSecretsV1,
  type OpenedKeystore,
} from '../../../src/core/index.ts';
import { valueWords } from '../../helpers/words.ts';

// Real scrypt at the default N=2^17 for every encrypt/decrypt in this file.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const PASSWORD = 'correct horse battery staple';
const FLEET = 'Flota testowa';
const MNEMONIC_12 = `${'abandon '.repeat(11)}about`;

type Code = AppError['code'];

function expectCode(fn: () => unknown, code: Code): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(AppError);
  expect((caught as AppError).code).toBe(code);
}

async function expectCodeAsync(promise: Promise<unknown>, code: Code): Promise<void> {
  const caught: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(caught).toBeInstanceOf(AppError);
  expect((caught as AppError).code).toBe(code);
}

/** Deep-clones the file as plain JSON so tests can tamper with it. */
function mutable(file: KeystoreFileV1): Record<string, unknown> & {
  public: { wallets: Record<string, unknown>[] };
  kdf: Record<string, unknown>;
  cipher: Record<string, unknown>;
} {
  return JSON.parse(JSON.stringify(file)) as ReturnType<typeof mutable>;
}

let created: OpenedKeystore;

beforeAll(async () => {
  created = await createKeystore({ fleetName: FLEET, walletCount: 30, password: PASSWORD });
});

describe('createKeystore + parseKeystoreFile + openKeystore', () => {
  it('round-trips 30 wallets: same mnemonic, keys and settings (bigint kept)', async () => {
    const withSettings: KeystoreSecretsV1 = {
      ...created.secrets,
      settings: {
        maxSpend: [
          { index: 0, lamports: 25_000_000n },
          { index: 7, lamports: 0n },
          { index: 29, lamports: 2n ** 64n - 1n },
        ],
      },
      apiKeys: { helius: 'helius-test-key', jupiter: 'jupiter-test-key' },
    };
    const file = await buildKeystore(withSettings, { fleetName: FLEET }, PASSWORD);
    const parsed = parseKeystoreFile(JSON.stringify(file));
    const opened = await openKeystore(parsed, PASSWORD);

    expect(opened.secrets).toEqual(withSettings);
    expect(opened.secrets.mnemonic).toBe(created.secrets.mnemonic);
    expect(opened.secrets.wallets).toHaveLength(30);
    expect(typeof opened.secrets.settings.maxSpend[2]?.lamports).toBe('bigint');
    expect(opened.secrets.settings.maxSpend[2]?.lamports).toBe(18_446_744_073_709_551_615n);
    expect(opened.file.public).toEqual(file.public);
  });

  it('opens the file produced by createKeystore (serialized form too)', async () => {
    const opened = await openKeystore(
      parseKeystoreFile(serializeKeystoreFile(created.file)),
      PASSWORD,
    );
    expect(opened.secrets).toEqual(created.secrets);
    expect(created.secrets.mnemonic.split(' ')).toHaveLength(24);
    expect(created.secrets.settings).toEqual({ maxSpend: [] });
    expect(created.secrets.apiKeys).toEqual({});
  });

  it('has exactly the SPEC 3.1 structure on every level', () => {
    const f = created.file;
    expect(Object.keys(f)).toEqual([
      'version',
      'fleetName',
      'createdAt',
      'kdf',
      'cipher',
      'ciphertext',
      'public',
    ]);
    expect(Object.keys(f.kdf).sort()).toEqual(['N', 'name', 'p', 'r', 'salt']);
    expect(Object.keys(f.cipher).sort()).toEqual(['iv', 'name']);
    expect(Object.keys(f.public)).toEqual(['wallets']);
    for (const w of f.public.wallets) {
      expect(Object.keys(w).sort()).toEqual(['address', 'derivationPath', 'index', 'label']);
    }
    expect(f.version).toBe(1);
    expect(f.fleetName).toBe(FLEET);
    expect(new Date(f.createdAt).toISOString()).toBe(f.createdAt);
    expect(f.kdf).toMatchObject({ name: 'scrypt', N: 131072, r: 8, p: 1 });
    expect(f.cipher.name).toBe('AES-GCM');
  });

  it('has correct indices, addresses, derivation paths and labels', () => {
    const derived = deriveWallets(created.secrets.mnemonic, 0, 30);
    expect(created.file.public.wallets).toEqual(
      derived.map((d) => ({
        index: d.index,
        address: d.address,
        derivationPath: `m/44'/501'/${String(d.index)}'/0'`,
        label: `W${String(d.index + 1).padStart(2, '0')}`,
      })),
    );
    expect(created.file.public.wallets[0]?.label).toBe('W01');
    expect(created.file.public.wallets[29]?.label).toBe('W30');
    expect(defaultWalletLabel(99)).toBe('W100');
    for (const d of derived) d.secretKey.fill(0);
  });

  it('stores secret keys in Phantom format matching the public addresses', () => {
    for (const w of created.secrets.wallets) {
      const bytes = base58.decode(w.secretKey);
      expect(bytes).toHaveLength(64);
      const pub = created.file.public.wallets.find((p) => p.index === w.index);
      expect(base58.encode(bytes.slice(32))).toBe(pub?.address);
    }
  });

  it('keeps every secret inside ciphertext only', () => {
    const json = JSON.stringify(created.file);
    const { mnemonic, wallets } = created.secrets;
    expect(json).not.toContain(mnemonic);
    for (const w of wallets) {
      expect(json).not.toContain(w.secretKey);
      // the 32-byte private seed alone, too
      expect(json).not.toContain(base58.encode(base58.decode(w.secretKey).slice(0, 32)));
    }
    // Outside base64 fields (where short words can occur by chance) no string value
    // contains a mnemonic word.
    const words = valueWords(created.file, ['ciphertext', 'salt', 'iv']);
    for (const word of new Set(mnemonic.split(' '))) {
      expect(words.has(word)).toBe(false);
    }
  });

  it('wrong password → KEYSTORE_WRONG_PASSWORD_OR_CORRUPTED', async () => {
    await expectCodeAsync(
      openKeystore(created.file, 'correct horse battery stapler'),
      'KEYSTORE_WRONG_PASSWORD_OR_CORRUPTED',
    );
  });

  it('imports an existing mnemonic (Phantom 12 words) with matching addresses', async () => {
    const { file, secrets } = await createKeystore({
      fleetName: 'Import',
      walletCount: 3,
      password: PASSWORD,
      mnemonic: `  ${MNEMONIC_12.toUpperCase()} `,
    });
    expect(secrets.mnemonic).toBe(MNEMONIC_12);
    // BUNNDLY-4 reference vectors (Phantom / solana-keygen).
    expect(file.public.wallets.map((w) => w.address)).toEqual([
      'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk',
      'Hh8QwFUA6MtVu1qAoq12ucvFHNwCcVTV7hpWjeY1Hztb',
      '7WktogJEd2wQ9eH2oWusmcoFTgeYi6rS632UviTBJ2jm',
    ]);
  });
});

describe('tampering with the public part', () => {
  it('a foreign but valid address → KEYSTORE_TAMPERED', async () => {
    const [foreign] = deriveWallets(MNEMONIC_12, 0, 1);
    expect(foreign).toBeDefined();
    const f = mutable(created.file);
    const target = f.public.wallets[5];
    expect(target).toBeDefined();
    if (!target || !foreign) return;
    target.address = foreign.address;
    foreign.secretKey.fill(0);
    const parsed = parseKeystoreFile(JSON.stringify(f)); // structurally valid
    await expectCodeAsync(openKeystore(parsed, PASSWORD), 'KEYSTORE_TAMPERED');
  });

  it('two swapped addresses → KEYSTORE_TAMPERED', async () => {
    const f = mutable(created.file);
    const [a, b] = [f.public.wallets[1], f.public.wallets[2]];
    if (!a || !b) throw new Error('fixture');
    [a.address, b.address] = [b.address, a.address];
    await expectCodeAsync(
      openKeystore(parseKeystoreFile(JSON.stringify(f)), PASSWORD),
      'KEYSTORE_TAMPERED',
    );
  });

  it('a wallet removed from the public list → KEYSTORE_TAMPERED', async () => {
    const f = mutable(created.file);
    f.public.wallets.pop();
    await expectCodeAsync(
      openKeystore(parseKeystoreFile(JSON.stringify(f)), PASSWORD),
      'KEYSTORE_TAMPERED',
    );
  });

  it('a wrong derivation path is rejected already by the parser', () => {
    const f = mutable(created.file);
    const w = f.public.wallets[0];
    if (!w) throw new Error('fixture');
    w.derivationPath = solanaDerivationPath(1);
    expectCode(() => parseKeystoreFile(JSON.stringify(f)), 'KEYSTORE_INVALID_FORMAT');
  });
});

describe('parseKeystoreFile on damaged files', () => {
  const base = (): ReturnType<typeof mutable> => mutable(created.file);
  const text = (value: unknown): string => JSON.stringify(value);

  it.each<[string, () => string, Code]>([
    ['invalid JSON', () => '{"version":1,', 'KEYSTORE_INVALID_FORMAT'],
    ['empty text', () => '', 'KEYSTORE_INVALID_FORMAT'],
    ['JSON array', () => '[]', 'KEYSTORE_INVALID_FORMAT'],
    ['JSON null', () => 'null', 'KEYSTORE_INVALID_FORMAT'],
    ['version 2', () => text({ ...base(), version: 2 }), 'KEYSTORE_UNSUPPORTED_VERSION'],
    ['version "1"', () => text({ ...base(), version: '1' }), 'KEYSTORE_UNSUPPORTED_VERSION'],
    ['missing version', () => text({ ...base(), version: undefined }), 'KEYSTORE_INVALID_FORMAT'],
    [
      'missing fleetName',
      () => text({ ...base(), fleetName: undefined }),
      'KEYSTORE_INVALID_FORMAT',
    ],
    [
      'missing createdAt',
      () => text({ ...base(), createdAt: undefined }),
      'KEYSTORE_INVALID_FORMAT',
    ],
    ['missing kdf', () => text({ ...base(), kdf: undefined }), 'KEYSTORE_INVALID_FORMAT'],
    ['missing cipher', () => text({ ...base(), cipher: undefined }), 'KEYSTORE_INVALID_FORMAT'],
    [
      'missing ciphertext',
      () => text({ ...base(), ciphertext: undefined }),
      'KEYSTORE_INVALID_FORMAT',
    ],
    ['missing public', () => text({ ...base(), public: undefined }), 'KEYSTORE_INVALID_FORMAT'],
    ['unknown top-level key', () => text({ ...base(), extra: 1 }), 'KEYSTORE_INVALID_FORMAT'],
    [
      'kdf.N as string',
      () => {
        const f = base();
        f.kdf.N = '131072';
        return text(f);
      },
      'KEYSTORE_INVALID_FORMAT',
    ],
    [
      'missing kdf.salt',
      () => {
        const f = base();
        delete f.kdf.salt;
        return text(f);
      },
      'KEYSTORE_INVALID_FORMAT',
    ],
    [
      'bad base64 ciphertext',
      () => text({ ...base(), ciphertext: 'not base64!' }),
      'KEYSTORE_INVALID_FORMAT',
    ],
    [
      'bad base64 salt',
      () => {
        const f = base();
        f.kdf.salt = '@@@';
        return text(f);
      },
      'KEYSTORE_INVALID_FORMAT',
    ],
    [
      'bad base64 iv',
      () => {
        const f = base();
        f.cipher.iv = 'a';
        return text(f);
      },
      'KEYSTORE_INVALID_FORMAT',
    ],
    [
      'bad base58 address',
      () => {
        const f = base();
        (f.public.wallets[0] ?? {}).address = '0OIl';
        return text(f);
      },
      'KEYSTORE_INVALID_FORMAT',
    ],
    [
      '31-byte address',
      () => {
        const f = base();
        (f.public.wallets[0] ?? {}).address = base58.encode(new Uint8Array(31).fill(1));
        return text(f);
      },
      'KEYSTORE_INVALID_FORMAT',
    ],
    [
      'duplicate index',
      () => {
        const f = base();
        (f.public.wallets[1] ?? {}).index = 0;
        return text(f);
      },
      'KEYSTORE_INVALID_FORMAT',
    ],
    [
      'index 100',
      () => {
        const f = base();
        (f.public.wallets[0] ?? {}).index = 100;
        return text(f);
      },
      'KEYSTORE_INVALID_FORMAT',
    ],
    [
      'empty wallet list',
      () => {
        const f = base();
        f.public.wallets = [];
        return text(f);
      },
      'KEYSTORE_INVALID_FORMAT',
    ],
    [
      'label too long',
      () => {
        const f = base();
        (f.public.wallets[0] ?? {}).label = 'x'.repeat(33);
        return text(f);
      },
      'KEYSTORE_INVALID_FORMAT',
    ],
    [
      'label with newline',
      () => {
        const f = base();
        (f.public.wallets[0] ?? {}).label = 'a\nb';
        return text(f);
      },
      'KEYSTORE_INVALID_FORMAT',
    ],
    [
      'createdAt not ISO',
      () => text({ ...base(), createdAt: '2026-10-02' }),
      'KEYSTORE_INVALID_FORMAT',
    ],
    [
      'fleetName with path',
      () => text({ ...base(), fleetName: '../evil' }),
      'KEYSTORE_INVALID_FORMAT',
    ],
  ])('%s → %s', (_label, make, code) => {
    expectCode(() => parseKeystoreFile(make()), code);
  });

  it('rejects files over 1 MB before parsing (ASCII and multi-byte)', () => {
    const valid = serializeKeystoreFile(created.file);
    expect(() => parseKeystoreFile(valid)).not.toThrow();
    const padded = valid + ' '.repeat(MAX_KEYSTORE_FILE_BYTES);
    expectCode(() => parseKeystoreFile(padded), 'KEYSTORE_INVALID_FORMAT');
    // 600k "ą" = 1.2 MB in UTF-8 but fewer than 1M UTF-16 units
    const multiByte = valid + 'ą'.repeat(600_000);
    expect(multiByte.length).toBeLessThan(MAX_KEYSTORE_FILE_BYTES);
    const spy = vi.spyOn(JSON, 'parse');
    expectCode(() => parseKeystoreFile(multiByte), 'KEYSTORE_INVALID_FORMAT');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('does not echo file content into errors', () => {
    let caught: unknown;
    try {
      parseKeystoreFile(text({ ...base(), fleetName: 'abandon ../ secret' }));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    const dump =
      JSON.stringify(caught, Object.getOwnPropertyNames(caught)) +
      String((caught as AppError).stack);
    expect(dump).not.toContain('abandon');
    expect('cause' in (caught as AppError)).toBe(false);
  });
});

describe('fleet names', () => {
  it.each(['Flota 1', 'moja_flota-2.0', 'Żółw', 'a', 'a'.repeat(64)])('%j is valid', (name) => {
    expect(isValidFleetName(name)).toBe(true);
  });

  it.each([
    '',
    'a'.repeat(65),
    '../x',
    'a/b',
    'a\\b',
    '.hidden',
    'end.',
    ' lead',
    'trail ',
    'a:b',
    'x*',
    'a\u0000b',
  ])('%j is invalid', (name) => {
    expect(isValidFleetName(name)).toBe(false);
  });
});

describe('createKeystore / buildKeystore input checks (no scrypt)', () => {
  it.each<[string, Parameters<typeof createKeystore>[0], Code]>([
    [
      'bad fleet name',
      { fleetName: 'a/b', walletCount: 1, password: PASSWORD },
      'INVALID_FLEET_NAME',
    ],
    [
      'short password',
      { fleetName: FLEET, walletCount: 1, password: 'short' },
      'PASSWORD_TOO_SHORT',
    ],
    [
      '0 wallets',
      { fleetName: FLEET, walletCount: 0, password: PASSWORD },
      'INVALID_DERIVATION_INDEX',
    ],
    [
      '101 wallets',
      { fleetName: FLEET, walletCount: 101, password: PASSWORD },
      'INVALID_DERIVATION_INDEX',
    ],
    [
      'bad mnemonic',
      { fleetName: FLEET, walletCount: 1, password: PASSWORD, mnemonic: 'abandon abandon' },
      'INVALID_MNEMONIC',
    ],
  ])('%s → %s', async (_label, params, code) => {
    const onProgress = vi.fn();
    await expectCodeAsync(createKeystore({ ...params, onProgress }), code);
    expect(onProgress).not.toHaveBeenCalled();
  });

  it('refuses to build a file whose keys do not belong to the mnemonic', async () => {
    const [foreign] = deriveWallets(MNEMONIC_12, 0, 1);
    if (!foreign) throw new Error('fixture');
    const bad: KeystoreSecretsV1 = {
      ...created.secrets,
      wallets: created.secrets.wallets.map((w) =>
        w.index === 3 ? { index: 3, secretKey: base58.encode(foreign.secretKey) } : w,
      ),
    };
    foreign.secretKey.fill(0);
    await expectCodeAsync(buildKeystore(bad, { fleetName: FLEET }, PASSWORD), 'KEYSTORE_TAMPERED');
  });

  it('refuses invalid settings before encrypting', async () => {
    const bad: KeystoreSecretsV1 = {
      ...created.secrets,
      settings: { maxSpend: [{ index: 99, lamports: 1n }] }, // wallet 99 is not in the fleet
    };
    await expectCodeAsync(
      buildKeystore(bad, { fleetName: FLEET }, PASSWORD),
      'KEYSTORE_INVALID_FORMAT',
    );
  });

  it('uses custom labels and keeps the rest default', async () => {
    const file = await buildKeystore(
      created.secrets,
      { fleetName: FLEET, labels: new Map([[0, 'Główny']]), createdAt: new Date(0) },
      PASSWORD,
    );
    expect(file.public.wallets[0]?.label).toBe('Główny');
    expect(file.public.wallets[1]?.label).toBe('W02');
    expect(file.createdAt).toBe('1970-01-01T00:00:00.000Z');
  });
});

describe('parseSecrets / secretsToJson', () => {
  const json = (): Record<string, unknown> =>
    JSON.parse(secretsToJson(created.secrets)) as Record<string, unknown>;

  it('round-trips bigint lamports as decimal strings', () => {
    const s: KeystoreSecretsV1 = {
      ...created.secrets,
      settings: { maxSpend: [{ index: 1, lamports: 123_456_789n }] },
    };
    const text = secretsToJson(s);
    expect(text).toContain('"lamports":"123456789"');
    expect(parseSecrets(JSON.parse(text))).toEqual(s);
  });

  it.each([
    ['negative', '-1'],
    ['leading zero', '01'],
    ['fraction', '1.5'],
    ['number instead of string', 5],
    ['above u64', (2n ** 64n).toString()],
  ])('lamports %s → KEYSTORE_INVALID_FORMAT', (_label, lamports) => {
    const raw = { ...json(), settings: { maxSpend: [{ index: 0, lamports }] } };
    expectCode(() => parseSecrets(raw), 'KEYSTORE_INVALID_FORMAT');
  });

  it.each<[string, () => unknown]>([
    ['unknown api key', () => ({ ...json(), apiKeys: { other: 'x' } })],
    ['empty api key', () => ({ ...json(), apiKeys: { helius: '' } })],
    [
      'secret key of 32 bytes',
      () => ({ ...json(), wallets: [{ index: 0, secretKey: base58.encode(new Uint8Array(32)) }] }),
    ],
    ['missing settings', () => ({ ...json(), settings: undefined })],
    ['not an object', () => 'x'],
  ])('%s → KEYSTORE_INVALID_FORMAT', (_label, make) => {
    expectCode(() => parseSecrets(make()), 'KEYSTORE_INVALID_FORMAT');
  });
});
