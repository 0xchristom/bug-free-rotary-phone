// Web Worker wiring watcher + executor, message protocol (SPEC 4). Vault: BUNNDLY-7.
export { spawnVaultWorker } from './spawn.ts';
export { createVaultClient, DEFAULT_SLOW_TIMEOUT_MS, DEFAULT_TIMEOUT_MS } from './vault-client.ts';
export type { VaultClient, VaultClientOptions } from './vault-client.ts';
export type {
  VaultFileResult,
  VaultInfo,
  VaultPort,
  VaultRequest,
  VaultRequestOf,
  VaultRequestType,
  VaultResultMap,
  VaultStatus,
} from './protocol.ts';
