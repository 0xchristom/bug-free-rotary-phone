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
  createSession,
  decryptSecrets,
  decryptWithSession,
  encryptSecrets,
  encryptWithSession,
  passwordLength,
  unlockSession,
} from './keystore/crypto.ts';
export type {
  AesKey,
  KeystoreSession,
  CipherParams,
  CryptoOptions,
  EncryptOptions,
  EncryptedSecrets,
  KdfParams,
  ScryptCost,
} from './keystore/crypto.ts';
export { KEYSTORE_FILE_SUFFIX } from './keystore/limits.ts';
export {
  API_KEY_NAMES,
  KEYSTORE_VERSION,
  defaultFleetSettings,
  isValidApiKeyValue,
  MAX_KEYSTORE_FILE_BYTES,
  isValidFleetName,
  parseKeystoreFile,
  parseSecrets,
  secretsToJson,
  serializeKeystoreFile,
} from './keystore/format.ts';
export type {
  ApiKeyName,
  ApiKeysV1,
  FleetSettingsV1,
  KeystoreFileV1,
  KeystoreSecretsV1,
  MaxSpendV1,
  PublicWalletV1,
  SecretWalletV1,
  WalletActiveV1,
} from './keystore/format.ts';
export * from './settings.ts';
export {
  buildKeystore,
  buildKeystoreWithSession,
  createKeystore,
  defaultWalletLabel,
  openKeystore,
} from './keystore/keystore.ts';
export type { CreateKeystoreParams, KeystoreMeta, OpenedKeystore } from './keystore/keystore.ts';
export { PLAIN_EXPORT_WARNING, buildPlainExport } from './keystore/export.ts';
export type { PlainExport, PlainExportFormat } from './keystore/export.ts';
