/**
 * Typed application errors (SPEC 5) with user-facing messages in English.
 *
 * Project rule (docs/DECISIONS.md, D-008): an error's message and fields never contain
 * input data that may be secret (mnemonic, password, private keys, plaintext). The
 * message always comes from ERROR_MESSAGES, never from the caller.
 */

import { NO_BUY_ROUTE_MESSAGE } from './network.ts';

/** Code → user-facing message (English). The keys define the ErrorCode union. */
export const ERROR_MESSAGES = {
  INVALID_MNEMONIC: 'Invalid recovery phrase. Check the words and their order.',
  INVALID_DERIVATION_INDEX:
    'Invalid wallet range. A fleet can have 1 to 100 wallets (indexes 0 to 99).',
  INVALID_FLEET_NAME:
    'Invalid fleet name. Use 1 to 64 characters: letters, digits, spaces, dots, hyphens or underscores.',
  PASSWORD_TOO_SHORT: 'The password is too short. Use at least 12 characters.',
  KEYSTORE_WRONG_PASSWORD_OR_CORRUPTED:
    'The file could not be decrypted. The password is wrong or the file is damaged.',
  KEYSTORE_INVALID_FORMAT: 'This is not a valid Bunndly fleet file.',
  KEYSTORE_UNSUPPORTED_VERSION: 'This fleet file version is not supported. Update the app.',
  KEYSTORE_UNSUPPORTED_KDF: 'The fleet file uses an unsupported password protection method.',
  KEYSTORE_TAMPERED:
    'The unencrypted part of the fleet file does not match the encrypted part. The file may have been modified.',
  INVALID_SETTINGS:
    'The settings are invalid. Fix the marked fields and try again. Nothing was saved.',
  RPC_UNAVAILABLE:
    'Could not read data from the Solana network (neither through Helius nor through the public RPC). Try again in a moment.',
  NOT_A_TOKEN_MINT:
    'This address is not a token mint (neither SPL Token nor Token-2022). Check the token address.',
  HELIUS_KEY_MISSING:
    'The Helius API key is missing. Add it in Settings: balances, live buys and the watcher need it.',
  VAULT_LOCKED: 'The fleet is locked. Unlock it with the password to continue.',
  BUY_RUNNING: 'A buy is running. Stop it with STOP and wait until the sent transactions finish.',
  NO_WALLETS_TO_BUY: 'No wallet can buy: mark wallets as active and set their max spend.',
  NO_WALLETS_TO_SELL: 'No wallet is marked for selling.',
  WALLET_IN_RUN:
    'A wallet in the running buy or sell keeps its trade settings until the run ends. Wait for it or press STOP.',
  GROUP_RUNNING:
    'This group is buying, selling or armed: its wallets stay in it until that ends. Wait for it, press STOP or DISARM.',
  INVALID_MINT_ADDRESS: 'This is not a valid token mint address (base58, 32–44 characters).',
  INVALID_CREATOR_ADDRESS:
    'This is not a valid creator wallet address (base58, 32 bytes, not the SOL mint).',
  INVALID_TARGET_ADDRESS: 'This is not a valid Solana address (base58, 32 bytes).',
  TARGET_IS_TOKEN_ACCOUNT:
    'This address is a token account, not a token. Paste the token mint or the creator wallet.',
  TARGET_IS_PROGRAM:
    'This address is a program, not a token. Paste the token mint or the creator wallet.',
  TARGET_UNSUPPORTED:
    'This address is neither a token mint nor a wallet. Paste the token mint or the creator wallet.',
  TARGET_KIND_MISMATCH:
    'BUY needs a token mint and ARM needs a creator wallet; this address is the other kind.',
  WATCH_ARMED:
    'The watcher is armed. Disarm it with DISARM first, then lock the fleet or change the settings or the fleet.',
  NO_BUY_ROUTE_ON_NETWORK: NO_BUY_ROUTE_MESSAGE,
  VAULT_TIMEOUT: 'The key vault did not respond in time. Try again.',
  INTERNAL_ERROR: 'An internal application error occurred. Try again.',
  STORAGE_CANCELLED: 'The file or folder choice was cancelled. No file was saved or loaded.',
  STORAGE_PERMISSION_DENIED:
    'The browser did not give access to the chosen folder or file. Allow access and try again.',
  STORAGE_WRITE_FAILED: 'The fleet file could not be saved. Try again or choose another folder.',
  STORAGE_READ_FAILED: 'The file could not be read. Try again.',
  STORAGE_FILE_TOO_LARGE: 'The file is too large (over 1 MB). This is not a Bunndly fleet file.',
  REMEMBER_UNAVAILABLE:
    'This browser does not let the page keep data (for example in a private window). The fleet cannot be remembered on this device.',
  NO_REMEMBERED_FLEET: 'No fleet is remembered on this device. Open the fleet file.',
} as const satisfies Record<string, string>;

export type ErrorCode = keyof typeof ERROR_MESSAGES;

/** Shown for any error that is not an AppError. Never derived from the error itself. */
export const UNKNOWN_ERROR_MESSAGE = 'An unexpected error occurred. Try again.';

export interface AppErrorOptions {
  /**
   * Underlying error, kept for debugging only. It is never shown to the user. Do not
   * pass anything whose message may contain secrets.
   */
  readonly cause?: unknown;
}

export class AppError extends Error {
  override readonly name = 'AppError';
  readonly code: ErrorCode;

  constructor(code: ErrorCode, options?: AppErrorOptions) {
    super(ERROR_MESSAGES[code], options && 'cause' in options ? { cause: options.cause } : {});
    this.code = code;
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

/**
 * Message safe to show to the user. For unknown errors it returns a generic message and
 * never `e.message`, because that may contain input data (SPEC 6.1).
 */
export function toUserMessage(e: unknown): string {
  return isAppError(e) ? ERROR_MESSAGES[e.code] : UNKNOWN_ERROR_MESSAGE;
}
