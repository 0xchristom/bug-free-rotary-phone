// Pure TS, no DOM: derivation, keystore crypto, types, state machine, limiter (SPEC 4).
export {
  AppError,
  ERROR_MESSAGES,
  UNKNOWN_ERROR_MESSAGE,
  isAppError,
  toUserMessage,
} from './errors.ts';
export type { AppErrorOptions, ErrorCode } from './errors.ts';
export {
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
} from './derivation.ts';
export type { DerivedWallet } from './derivation.ts';
export {
  DEFAULT_SCRYPT_N,
  MAX_SCRYPT_N,
  MAX_SCRYPT_P,
  MIN_PASSWORD_LENGTH,
  MIN_SCRYPT_N,
  MIN_SCRYPT_P,
  SCRYPT_R,
  decryptSecrets,
  encryptSecrets,
  passwordLength,
} from './keystore/crypto.ts';
export type {
  CipherParams,
  CryptoOptions,
  EncryptOptions,
  EncryptedSecrets,
  KdfParams,
  ScryptCost,
} from './keystore/crypto.ts';
