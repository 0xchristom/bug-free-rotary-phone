import { describe, expect, it } from 'vitest';
import {
  AppError,
  ERROR_MESSAGES,
  UNKNOWN_ERROR_MESSAGE,
  isAppError,
  toUserMessage,
  type ErrorCode,
} from '../../src/core/index.ts';

const SECRET_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const codes = Object.keys(ERROR_MESSAGES) as ErrorCode[];

describe('ERROR_MESSAGES', () => {
  it('contains exactly the known codes', () => {
    expect([...codes].sort()).toEqual(
      [
        'INVALID_DERIVATION_INDEX',
        'INVALID_FLEET_NAME',
        'INVALID_MNEMONIC',
        'KEYSTORE_INVALID_FORMAT',
        'KEYSTORE_TAMPERED',
        'KEYSTORE_UNSUPPORTED_KDF',
        'KEYSTORE_UNSUPPORTED_VERSION',
        'KEYSTORE_WRONG_PASSWORD_OR_CORRUPTED',
        'PASSWORD_TOO_SHORT',
        'VAULT_LOCKED',
        'INVALID_SETTINGS',
        'RPC_UNAVAILABLE',
        'NOT_A_TOKEN_MINT',
        'HELIUS_KEY_MISSING',
        'VAULT_TIMEOUT',
        'INTERNAL_ERROR',
        'STORAGE_CANCELLED',
        'STORAGE_PERMISSION_DENIED',
        'STORAGE_WRITE_FAILED',
        'STORAGE_READ_FAILED',
        'STORAGE_FILE_TOO_LARGE',
      ].sort(),
    );
  });

  it.each(codes)('%s has a non-empty Polish message', (code) => {
    const message = ERROR_MESSAGES[code];
    expect(message.trim().length).toBeGreaterThan(0);
    // Polish UI copy, not a bare code or English placeholder.
    expect(message).not.toBe(code);
    expect(message).toMatch(/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]|\b(jest|nie|plik|hasło)\b/i);
  });

  it('has a distinct message per code', () => {
    expect(new Set(Object.values(ERROR_MESSAGES)).size).toBe(codes.length);
  });
});

describe('AppError', () => {
  it('works with instanceof and exposes code, name and message', () => {
    const err = new AppError('INVALID_MNEMONIC');
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('INVALID_MNEMONIC');
    expect(err.name).toBe('AppError');
    expect(err.message).toBe(ERROR_MESSAGES.INVALID_MNEMONIC);
    expect(err.stack).toBeTypeOf('string');
  });

  it('preserves cause', () => {
    const cause = new DOMException('The operation failed', 'OperationError');
    const err = new AppError('KEYSTORE_WRONG_PASSWORD_OR_CORRUPTED', { cause });
    expect(err.cause).toBe(cause);
  });

  it('preserves an explicitly undefined cause and omits a missing one', () => {
    expect('cause' in new AppError('KEYSTORE_TAMPERED')).toBe(false);
    const err = new AppError('KEYSTORE_TAMPERED', { cause: undefined });
    expect('cause' in err).toBe(true);
    expect(err.cause).toBeUndefined();
  });

  it('rejects unknown codes at compile time', () => {
    // @ts-expect-error: typo in the code must not compile
    const err = new AppError('INVALID_MNEMONICC');
    expect(err).toBeInstanceOf(AppError);
  });
});

describe('isAppError', () => {
  it('distinguishes AppError from other values', () => {
    expect(isAppError(new AppError('PASSWORD_TOO_SHORT'))).toBe(true);
    expect(isAppError(new Error('x'))).toBe(false);
    expect(isAppError({ name: 'AppError', code: 'PASSWORD_TOO_SHORT', message: 'x' })).toBe(false);
    expect(isAppError('PASSWORD_TOO_SHORT')).toBe(false);
    expect(isAppError(undefined)).toBe(false);
    expect(isAppError(null)).toBe(false);
  });
});

describe('toUserMessage', () => {
  it('returns the mapped message for AppError', () => {
    for (const code of codes) {
      expect(toUserMessage(new AppError(code))).toBe(ERROR_MESSAGES[code]);
    }
  });

  it('uses the code mapping even if message was overwritten', () => {
    const err = new AppError('INVALID_MNEMONIC');
    err.message = SECRET_MNEMONIC;
    expect(toUserMessage(err)).toBe(ERROR_MESSAGES.INVALID_MNEMONIC);
  });

  it('never returns the content of an unknown Error', () => {
    const msg = toUserMessage(new Error(SECRET_MNEMONIC));
    expect(msg).toBe(UNKNOWN_ERROR_MESSAGE);
    expect(msg).not.toContain('abandon');
  });

  it('does not leak the cause of an AppError', () => {
    const err = new AppError('KEYSTORE_INVALID_FORMAT', { cause: new Error(SECRET_MNEMONIC) });
    expect(toUserMessage(err)).not.toContain('abandon');
  });

  it.each([
    ['a string', SECRET_MNEMONIC],
    ['undefined', undefined],
    ['null', null],
    ['an object with message', { message: SECRET_MNEMONIC }],
    ['a TypeError', new TypeError(SECRET_MNEMONIC)],
  ])('returns the generic message for %s', (_label, value) => {
    expect(toUserMessage(value)).toBe(UNKNOWN_ERROR_MESSAGE);
  });
});
