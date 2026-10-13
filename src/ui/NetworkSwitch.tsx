import { NETWORKS, NETWORK_LABELS, type Network } from '../core/network.ts';
import { supportsDirectoryPicker, type StorageEnv } from '../storage/keystore-file.ts';
import type { NetworkSwitching } from './use-network-switch.ts';

const LOCKED_HINT = 'The network is saved in the fleet file: open a fleet to change it.';

export interface NetworkSwitchProps {
  readonly network: Network;
  /** No open fleet: the network is shown, not changed. */
  readonly locked: boolean;
  readonly onChoose: (network: Network) => void;
}

/** Mainnet / Devnet in the header, on every screen. Devnet is marked by colour and text. */
export function NetworkSwitch({ network, locked, onChoose }: NetworkSwitchProps) {
  return (
    <div
      className={`network-switch ${network}`}
      role="group"
      aria-label="Network"
      title={locked ? LOCKED_HINT : undefined}
    >
      {NETWORKS.map((n) => (
        <button
          key={n}
          type="button"
          aria-pressed={n === network}
          disabled={locked}
          onClick={() => {
            onChoose(n);
          }}
        >
          {NETWORK_LABELS[n]}
        </button>
      ))}
    </div>
  );
}

/** Under the header: why the network did not change, and the fleet file to write. */
export function NetworkNotice({
  switching,
  storage,
}: {
  readonly switching: NetworkSwitching;
  readonly storage: StorageEnv;
}) {
  const { file, message, save } = switching;
  return (
    <>
      {message && (
        <p className="notice error" role="alert">
          {message}
        </p>
      )}
      {file?.kind === 'unsaved' && (
        <div className="notice warning" role="status">
          <p>
            {NETWORK_LABELS[file.network]} is set for this session only. Save the updated fleet
            file: without it the choice is lost when you close the tab, and the old file opens the
            fleet on the previous network.
          </p>
          {!supportsDirectoryPicker(storage) && (
            <p className="muted">Your browser will download the file. Check “Downloads” then.</p>
          )}
          <div className="actions">
            <button type="button" className="primary" disabled={file.saving} onClick={save}>
              {file.saving ? 'Saving…' : 'Save the fleet file with the new network'}
            </button>
          </div>
        </div>
      )}
      {file?.kind === 'saved' && (
        <p className="notice" role="status">
          Saved {file.fileName} with the new network.
        </p>
      )}
    </>
  );
}
