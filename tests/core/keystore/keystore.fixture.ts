/** Shared constants and helpers of the keystore test files (split in BUNNDLY-75). */
import { expect } from 'vitest';
import { AppError, type KeystoreFileV1 } from '../../../src/core/index.ts';

export const PASSWORD = 'correct horse battery staple';
export const FLEET = 'Flota testowa';
export const MNEMONIC_12 = `${'abandon '.repeat(11)}about`;

export type Code = AppError['code'];

export function expectCode(fn: () => unknown, code: Code): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(AppError);
  expect((caught as AppError).code).toBe(code);
}

export async function expectCodeAsync(promise: Promise<unknown>, code: Code): Promise<void> {
  const caught: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(caught).toBeInstanceOf(AppError);
  expect((caught as AppError).code).toBe(code);
}

/** Deep-clones the file as plain JSON so tests can tamper with it. */
export function mutable(file: KeystoreFileV1): Record<string, unknown> & {
  public: { wallets: Record<string, unknown>[] };
  kdf: Record<string, unknown>;
  cipher: Record<string, unknown>;
} {
  return JSON.parse(JSON.stringify(file)) as ReturnType<typeof mutable>;
}
