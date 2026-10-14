/**
 * The one end-to-end test with real scrypt (BUNNDLY-74): the worker creates a fleet file,
 * locks, and opens it again with the password, through `@noble/hashes/scrypt.js` itself.
 * Every other worker and UI test uses the fast stand-in (tests/helpers/fast-kdf.ts); the
 * parameters and the derivation are tested in tests/core/keystore/**.
 *
 * No `vi.mock` here on purpose. Real scrypt reports its progress in many steps, the
 * stand-in once with 1: the progress assertion turns red if this file ever gets the mock.
 */
import { describe, expect, it, vi } from 'vitest';
import { parseKeystoreFile } from '../../src/core/index.ts';
import type { VaultFileResult, VaultStatus } from '../../src/worker/protocol.ts';
import { createVaultHandler } from '../../src/worker/vault.ts';

vi.setConfig({ testTimeout: 60_000 });

const PASSWORD = 'correct horse battery staple';

describe('real scrypt, end to end', () => {
  it('create → lock → unlock with the password; a wrong password does not open the file', async () => {
    const h = createVaultHandler({ autoLockMs: 60_000 });
    const created = (await h.handle({
      type: 'create',
      fleetName: 'Real KDF',
      walletCount: 2,
      password: PASSWORD,
    })) as VaultFileResult;
    const file = parseKeystoreFile(created.fileText);
    expect(file.kdf).toMatchObject({ name: 'scrypt', N: 131072, r: 8, p: 1 });

    await h.handle({ type: 'lock' });
    const wrong = await h
      .handle({ type: 'unlock', fileText: created.fileText, password: `${PASSWORD}!` })
      .then(
        () => 'opened',
        (e: unknown) => (e as { code?: string }).code,
      );
    expect(wrong).toBe('KEYSTORE_WRONG_PASSWORD_OR_CORRUPTED');

    const progress: number[] = [];
    const opened = (await h.handle(
      { type: 'unlock', fileText: created.fileText, password: PASSWORD },
      {
        onProgress: (p) => {
          progress.push(p);
        },
      },
    )) as VaultStatus;
    expect(opened.locked).toBe(false);
    expect(opened.info?.wallets.map((w) => w.address)).toEqual(
      created.info.wallets.map((w) => w.address),
    );
    // Real scrypt: many steps between 0 and 1. The stand-in reports only [1].
    expect(progress.filter((p) => p > 0 && p < 1).length).toBeGreaterThan(5);
  });
});
