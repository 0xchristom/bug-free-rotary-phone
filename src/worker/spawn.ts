/** Starts the vault worker and returns its client (UI thread only). */
import { createVaultClient, type VaultClient, type VaultClientOptions } from './vault-client.ts';

export function spawnVaultWorker(options?: VaultClientOptions): VaultClient {
  const worker = new Worker(new URL('./vault.worker.ts', import.meta.url), { type: 'module' });
  return createVaultClient(
    {
      postMessage: (message) => {
        worker.postMessage(message);
      },
      addEventListener: (type, listener) => {
        worker.addEventListener(type, listener);
      },
    },
    options,
  );
}
