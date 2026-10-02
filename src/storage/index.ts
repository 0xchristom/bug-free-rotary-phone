// File System Access API + download/upload fallback (SPEC 4). Keystore file: BUNNDLY-8.
export { browserStorageEnv } from './browser.ts';
export {
  DOWNLOAD_URL_TTL_MS,
  keystoreFileName,
  openKeystoreFile,
  readKeystoreFile,
  saveKeystoreFile,
  supportsDirectoryPicker,
} from './keystore-file.ts';
export type { OpenedFile, SaveOptions, SaveResult, StorageEnv } from './keystore-file.ts';
