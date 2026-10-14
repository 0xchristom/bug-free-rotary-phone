/**
 * Vault Web Worker entry (module worker). Holds the keys; see vault.ts.
 * Spawned by spawnVaultWorker() in spawn.ts.
 */
import { indexedDbRememberStore } from '../storage/remember-idb.ts';
import { attachVaultHandler, createVaultHandler } from './vault.ts';

const AUTO_LOCK_CHECK_MS = 15_000;

const handler = createVaultHandler({ remember: indexedDbRememberStore() });
attachVaultHandler(self, handler);
setInterval(() => {
  handler.checkAutoLock();
}, AUTO_LOCK_CHECK_MS);
