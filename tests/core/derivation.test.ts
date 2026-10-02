import { base58, hex } from '@scure/base';
import { HDKey } from 'micro-key-producer/slip10.js';
import { describe, expect, it } from 'vitest';
import {
  AppError,
  ERROR_MESSAGES,
  MAX_FLEET_SIZE,
  deriveSlip10Ed25519,
  deriveWallets,
  generateMnemonic,
  normalizeMnemonic,
  parseMnemonic,
  secretKeyToBase58,
  solanaDerivationPath,
  validateMnemonic,
  wipe,
} from '../../src/core/index.ts';
import slip10 from '../fixtures/slip10-ed25519.json' with { type: 'json' };

/*
 * Reference vectors (BUNNDLY-4). Computed by Andy with two independent implementations:
 * solders 0.29.0 (Rust solana-sdk, same derivation as `solana-keygen --derivation-path`)
 * and a separate SLIP-0010 + RFC 8032 script. The 12-word index 0 address is the
 * well-known Phantom address for that mnemonic. Public BIP39 test mnemonics, no funds.
 */
const MNEMONIC_24 = `${'abandon '.repeat(23)}art`;
const MNEMONIC_12 = `${'abandon '.repeat(11)}about`;

const VECTORS: readonly { name: string; mnemonic: string; addresses: readonly string[] }[] = [
  {
    name: '24 words (23 × abandon + art)',
    mnemonic: MNEMONIC_24,
    addresses: [
      '3Cy3YNTFywCmxoxt8n7UH6hg6dLo5uACowX3CFceaSnx',
      '5frqxtii9LeGq2bz3dSNokvZcEooF483MzeU24JrhcTA',
      '3SuKj3MZU9dMZ9oR1R7afttihZFkWpfUmduuv9rmfMa1',
    ],
  },
  {
    name: '12 words (11 × abandon + about)',
    mnemonic: MNEMONIC_12,
    addresses: [
      'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk',
      'Hh8QwFUA6MtVu1qAoq12ucvFHNwCcVTV7hpWjeY1Hztb',
      '7WktogJEd2wQ9eH2oWusmcoFTgeYi6rS632UviTBJ2jm',
    ],
  },
];

function expectAppError(fn: () => unknown, code: AppError['code']): AppError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).code).toBe(code);
    return e as AppError;
  }
  throw new Error(`expected AppError ${code}`);
}

/** Every own property of the error, serialized, must not contain any input word. */
function expectNoWordsLeaked(err: AppError, input: string): void {
  const dump = JSON.stringify(err, Object.getOwnPropertyNames(err)) + String(err.stack);
  const words = new Set(
    normalizeMnemonic(input)
      .split(' ')
      .filter((w) => w.length > 2),
  );
  for (const word of words) {
    expect(dump.toLowerCase()).not.toContain(word);
  }
  expect('cause' in err).toBe(false);
}

describe('reference vectors (Phantom / solana-keygen)', () => {
  it.each(VECTORS)('$name: indices 0–2 match exactly', ({ mnemonic, addresses }) => {
    const wallets = deriveWallets(mnemonic, 0, 3);
    expect(wallets.map((w) => w.address)).toEqual(addresses);
    expect(wallets.map((w) => w.index)).toEqual([0, 1, 2]);
    expect(wallets.map((w) => w.derivationPath)).toEqual([
      "m/44'/501'/0'/0'",
      "m/44'/501'/1'/0'",
      "m/44'/501'/2'/0'",
    ]);
  });

  it('derives the same wallet regardless of fromIndex', () => {
    const [w2] = deriveWallets(MNEMONIC_24, 2, 1);
    expect(w2?.address).toBe(VECTORS[0]?.addresses[2]);
  });

  it('accepts unnormalized input (case, spaces, NFKD)', () => {
    const messy = `  ${MNEMONIC_12.toUpperCase().replaceAll(' ', ' \t\n ')}  `;
    expect(deriveWallets(messy, 0, 1)[0]?.address).toBe(VECTORS[1]?.addresses[0]);
  });
});

describe('official SLIP-0010 ed25519 vectors', () => {
  const cases = slip10.vectors.flatMap((v) =>
    v.chains.map((c) => ({ ...c, name: v.name, seed: v.seed })),
  );

  it.each(cases)('$name, $path', ({ seed, path, privateKey, chainCode, publicKey }) => {
    const indices =
      path === 'm'
        ? []
        : path
            .split('/')
            .slice(1)
            .map((p) => Number(p.replace("'", '')));
    const key = deriveSlip10Ed25519(hex.decode(seed), indices);
    expect(hex.encode(key.privateKey)).toBe(privateKey);
    expect(hex.encode(key.chainCode)).toBe(chainCode);
    // SLIP-0010 serializes ed25519 public keys as 0x00 || A (RFC 8032).
    expect(`00${hex.encode(new HDKey(key).publicKeyRaw)}`).toBe(publicKey);
  });

  it('covers both test vectors and all their paths', () => {
    expect(cases).toHaveLength(12);
  });
});

describe('secret key format', () => {
  it('is 64 bytes: private seed + public key; base58 round-trips; address = base58(pubkey)', () => {
    for (const wallet of deriveWallets(MNEMONIC_24, 0, 3)) {
      expect(wallet.secretKey).toHaveLength(64);
      const exported = secretKeyToBase58(wallet.secretKey);
      const decoded = base58.decode(exported);
      expect(decoded).toHaveLength(64);
      expect(decoded).toEqual(wallet.secretKey);
      expect(base58.encode(decoded.slice(32))).toBe(wallet.address);
    }
  });

  it('rejects secret keys of the wrong length without echoing them', () => {
    expect(() => secretKeyToBase58(new Uint8Array(32).fill(7))).toThrow(
      'secretKey must be 64 bytes',
    );
  });
});

describe('generateMnemonic', () => {
  it('produces 24 valid words and different results each time', () => {
    const a = generateMnemonic();
    const b = generateMnemonic();
    expect(a.split(' ')).toHaveLength(24);
    expect(b.split(' ')).toHaveLength(24);
    expect(validateMnemonic(a)).toBe(true);
    expect(validateMnemonic(b)).toBe(true);
    expect(a).not.toBe(b);
  });

  it('round-trips through deriveWallets', () => {
    expect(deriveWallets(generateMnemonic(), 0, 1)).toHaveLength(1);
  });
});

describe('mnemonic validation', () => {
  it('accepts every BIP39 length from 12 to 24 words', () => {
    // Valid checksums for all-"abandon" mnemonics of each length (BIP39 test vectors).
    const valid = [
      `${'abandon '.repeat(11)}about`,
      `${'abandon '.repeat(14)}address`,
      `${'abandon '.repeat(17)}agent`,
      `${'abandon '.repeat(20)}admit`,
      `${'abandon '.repeat(23)}art`,
    ];
    for (const m of valid) {
      expect(validateMnemonic(m)).toBe(true);
      expect(parseMnemonic(m)).toBe(normalizeMnemonic(m));
    }
  });

  it('normalizes to NFKD, lower case and single spaces', () => {
    expect(normalizeMnemonic('  Abandon \tABOUT  ')).toBe('abandon about');
    expect(normalizeMnemonic('café')).toBe('café');
  });

  const invalid: readonly [string, string][] = [
    ['bad checksum', `${'abandon '.repeat(11)}abandon`],
    ['word outside the list', `${'abandon '.repeat(11)}bitcoinz`],
    ['wrong word count (11)', `${'abandon '.repeat(10)}about`],
    ['wrong word count (13)', `${'abandon '.repeat(12)}about`],
    ['empty input', '   '],
  ];

  it.each(invalid)('%s → INVALID_MNEMONIC without leaking words', (_label, input) => {
    expect(validateMnemonic(input)).toBe(false);
    expectNoWordsLeaked(
      expectAppError(() => parseMnemonic(input), 'INVALID_MNEMONIC'),
      input,
    );
    expectNoWordsLeaked(
      expectAppError(() => deriveWallets(input, 0, 1), 'INVALID_MNEMONIC'),
      input,
    );
  });

  it('does not leak a real-looking secret phrase', () => {
    const almost = MNEMONIC_24.replace(/art$/u, 'zoo');
    expectNoWordsLeaked(
      expectAppError(() => deriveWallets(almost, 0, 1), 'INVALID_MNEMONIC'),
      'art zoo abandon',
    );
  });
});

describe('index range', () => {
  it('allows the full fleet 0..99', () => {
    const wallets = deriveWallets(MNEMONIC_12, 0, MAX_FLEET_SIZE);
    expect(wallets).toHaveLength(100);
    expect(wallets.at(-1)?.derivationPath).toBe(solanaDerivationPath(99));
    expect(new Set(wallets.map((w) => w.address)).size).toBe(100);
    expect(deriveWallets(MNEMONIC_12, 99, 1)[0]?.address).toBe(wallets[99]?.address);
  });

  it.each([
    ['negative fromIndex', -1, 1],
    ['fractional fromIndex', 0.5, 1],
    ['NaN fromIndex', Number.NaN, 1],
    ['Infinity fromIndex', Number.POSITIVE_INFINITY, 1],
    ['zero count', 0, 0],
    ['negative count', 0, -3],
    ['fractional count', 0, 1.5],
    ['NaN count', 0, Number.NaN],
    ['beyond 100', 99, 2],
    ['count over 100', 0, 101],
    ['fromIndex 100', 100, 1],
  ])('%s → INVALID_DERIVATION_INDEX', (_label, fromIndex, count) => {
    expectAppError(() => deriveWallets(MNEMONIC_12, fromIndex, count), 'INVALID_DERIVATION_INDEX');
  });

  it('error message states the same range as MAX_FLEET_SIZE', () => {
    const message = ERROR_MESSAGES.INVALID_DERIVATION_INDEX;
    expect(message).toContain(`od 1 do ${String(MAX_FLEET_SIZE)}`);
    expect(message).toContain(`od 0 do ${String(MAX_FLEET_SIZE - 1)}`);
  });

  it('checks the range before touching the mnemonic', () => {
    expectAppError(() => deriveWallets('not a mnemonic', -1, 1), 'INVALID_DERIVATION_INDEX');
  });

  it('rejects non-hardenable SLIP-0010 path indices', () => {
    const seed = new Uint8Array(16);
    expectAppError(() => deriveSlip10Ed25519(seed, [2 ** 31]), 'INVALID_DERIVATION_INDEX');
    expectAppError(() => deriveSlip10Ed25519(seed, [-1]), 'INVALID_DERIVATION_INDEX');
  });
});

describe('wipe', () => {
  it('zeroes every buffer passed in', () => {
    const a = new Uint8Array([1, 2, 3]);
    const b = new Uint8Array(64).fill(9);
    wipe(a, b);
    expect([...a, ...b].every((x) => x === 0)).toBe(true);
  });

  it('can wipe derived secret keys', () => {
    const [w] = deriveWallets(MNEMONIC_24, 0, 1);
    expect(w).toBeDefined();
    if (!w) return;
    wipe(w.secretKey);
    expect(w.secretKey.every((x) => x === 0)).toBe(true);
  });
});
