import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  createKeystore,
  deriveWallets,
  openKeystore,
  parseKeystoreFile,
  solanaDerivationPath,
  type OpenedKeystore,
} from '../../../src/core/index.ts';
import {
  FLEET,
  MNEMONIC_12,
  PASSWORD,
  expectCode,
  expectCodeAsync,
  mutable,
} from './keystore.fixture.ts';

// Real scrypt at the default N=2^17 for every encrypt/decrypt in this file.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let created: OpenedKeystore;

beforeAll(async () => {
  created = await createKeystore({ fleetName: FLEET, walletCount: 30, password: PASSWORD });
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
