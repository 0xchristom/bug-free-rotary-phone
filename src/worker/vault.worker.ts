/**
 * Vault Web Worker entry (module worker). Holds the keys; see vault.ts.
 * Spawned by spawnVaultWorker() in spawn.ts.
 */
import { indexedDbBackupStore } from '../storage/backup-idb.ts';
import { indexedDbRememberStore } from '../storage/remember-idb.ts';
import { attachVaultHandler, createVaultHandler } from './vault.ts';

const AUTO_LOCK_CHECK_MS = 15_000;

const handler = createVaultHandler({
  remember: indexedDbRememberStore(),
  backup: indexedDbBackupStore(),
});
attachVaultHandler(self, handler);
setInterval(() => {
  handler.checkAutoLock();
}, AUTO_LOCK_CHECK_MS);
