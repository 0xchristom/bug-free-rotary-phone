/**
 * Typed application errors (SPEC 5) with user-facing messages in Polish.
 *
 * Project rule (docs/DECISIONS.md, D-008): an error's message and fields never contain
 * input data that may be secret (mnemonic, password, private keys, plaintext). The
 * message always comes from ERROR_MESSAGES, never from the caller.
 */

/** Code → user-facing message (Polish). The keys define the ErrorCode union. */
export const ERROR_MESSAGES = {
  INVALID_MNEMONIC: 'Nieprawidłowa fraza odzyskiwania (mnemonik). Sprawdź słowa i ich kolejność.',
  INVALID_DERIVATION_INDEX:
    'Nieprawidłowy zakres portfeli. Flota może mieć od 1 do 100 portfeli (indeksy od 0 do 99).',
  INVALID_FLEET_NAME:
    'Nieprawidłowa nazwa floty. Użyj od 1 do 64 znaków: liter, cyfr, spacji, kropki, myślnika lub podkreślenia.',
  PASSWORD_TOO_SHORT: 'Hasło jest za krótkie. Użyj co najmniej 12 znaków.',
  KEYSTORE_WRONG_PASSWORD_OR_CORRUPTED:
    'Nie udało się odszyfrować pliku. Hasło jest błędne albo plik jest uszkodzony.',
  KEYSTORE_INVALID_FORMAT: 'To nie jest prawidłowy plik keystore Bunndly.',
  KEYSTORE_UNSUPPORTED_VERSION:
    'Ta wersja pliku keystore nie jest obsługiwana. Zaktualizuj aplikację.',
  KEYSTORE_UNSUPPORTED_KDF: 'Plik keystore używa nieobsługiwanej metody zabezpieczenia hasła.',
  KEYSTORE_TAMPERED:
    'Jawna część pliku keystore nie zgadza się z zaszyfrowaną. Plik mógł zostać zmodyfikowany.',
  INVALID_SETTINGS:
    'Ustawienia są nieprawidłowe. Popraw zaznaczone pola i spróbuj ponownie. Nic nie zostało zapisane.',
  VAULT_LOCKED: 'Plik floty jest zablokowany. Odblokuj go hasłem, aby kontynuować.',
  VAULT_TIMEOUT: 'Sejf z kluczami nie odpowiedział w wyznaczonym czasie. Spróbuj ponownie.',
  INTERNAL_ERROR: 'Wystąpił wewnętrzny błąd aplikacji. Spróbuj ponownie.',
  STORAGE_CANCELLED: 'Anulowano wybór pliku lub folderu. Plik nie został zapisany ani wczytany.',
  STORAGE_PERMISSION_DENIED:
    'Przeglądarka nie dała dostępu do wybranego folderu lub pliku. Zezwól na dostęp i spróbuj ponownie.',
  STORAGE_WRITE_FAILED:
    'Nie udało się zapisać pliku floty. Spróbuj ponownie lub wybierz inny folder.',
  STORAGE_READ_FAILED: 'Nie udało się odczytać pliku. Spróbuj ponownie.',
  STORAGE_FILE_TOO_LARGE: 'Plik jest za duży (ponad 1 MB). To nie jest plik floty Bunndly.',
} as const satisfies Record<string, string>;

export type ErrorCode = keyof typeof ERROR_MESSAGES;

/** Shown for any error that is not an AppError. Never derived from the error itself. */
export const UNKNOWN_ERROR_MESSAGE = 'Wystąpił nieoczekiwany błąd. Spróbuj ponownie.';

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
