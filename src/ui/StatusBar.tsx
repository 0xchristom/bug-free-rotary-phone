import type { FeedState } from '../chain/balance-stream.ts';
import { NETWORK_LABELS } from '../core/network.ts';
import type { VaultStatus } from '../worker/protocol.ts';
import { Chip, FolderIcon } from './kit/index.ts';
import { FEED_LABELS, type RpcRead } from './shell-status.ts';
import { connectionLabel, connectionTone } from './watch-labels.ts';

export interface StatusBarProps {
  readonly version: string;
  /** null until the vault answers for the first time. */
  readonly status: VaultStatus | null;
  /** The last balance read on the open fleet's network; null before the first one. */
  readonly read: RpcRead | null;
  /** Live or polling balances (BUNNDLY-57); null while no screen reads them. */
  readonly feed?: FeedState | null;
  readonly autoLockMinutes: number;
  /** Opens the plain export of the recovery phrase and keys; null while locked. */
  readonly onExport?: (() => void) | null;
}

const SOCKET_TONE = { ok: 'ok', wait: 'warn', bad: 'danger' } as const;

/**
 * The rail at the bottom of the window: what the app runs on right now. It reports only
 * what was measured: no read yet is said as such, and a read answered by the public RPC
 * is called a fallback, never Helius.
 */
export function StatusBar({
  version,
  status,
  read,
  feed = null,
  autoLockMinutes,
  onExport = null,
}: StatusBarProps) {
  const open = status !== null && !status.locked && status.info !== null ? status : null;
  const watch = open?.watch?.armed === true ? open.watch : null;
  const socketTone = watch === null ? null : SOCKET_TONE[connectionTone(watch.connection)];
  return (
    <footer className="rail" aria-label="Status">
      <span>v{version}</span>
      {status && (
        <>
          <span className="rail-sep" aria-hidden="true" />
          <Chip size="sm" tone={status.network === 'devnet' ? 'warn' : 'muted'}>
            {NETWORK_LABELS[status.network]}
          </Chip>
        </>
      )}
      {open && (
        <>
          <span className="rail-sep" aria-hidden="true" />
          <span role="status">
            {open.armed
              ? 'Armed: auto-lock is paused'
              : `Auto-lock after ${String(autoLockMinutes)} min of inactivity`}
          </span>
          <div className="rail-right">
            <span className="rail-item">
              <FolderIcon />
              Backup: manual
              {onExport && (
                <button type="button" className="linkbtn" onClick={onExport}>
                  Plain export (recovery phrase and keys)
                </button>
              )}
            </span>
            <span className="rail-sep" aria-hidden="true" />
            {read === null ? (
              <span className="rail-item">RPC: no read yet</span>
            ) : read.source === 'helius' ? (
              <span className="rail-item">
                Helius RPC <b>{String(read.ms)} ms</b>
              </span>
            ) : (
              <span className="rail-item" data-tone="warn">
                Fallback RPC (public) <b>{String(read.ms)} ms</b>
              </span>
            )}
            {read !== null && (
              <span className="rail-item" aria-live="polite">
                Balances as of {new Date(read.at).toLocaleTimeString('en-GB')}
              </span>
            )}
            {feed !== null && (
              <>
                <span className="rail-sep" aria-hidden="true" />
                {/* Said in words: polling is never shown as live (BUNNDLY-57). */}
                <span className="rail-item" data-tone={feed === 'live' ? 'ok' : 'warn'}>
                  Balances: {FEED_LABELS[feed]}
                </span>
              </>
            )}
            <span className="rail-sep" aria-hidden="true" />
            {watch === null || socketTone === null ? (
              <span className="rail-item">WebSocket: off</span>
            ) : (
              <span className="rail-item" data-tone={socketTone}>
                <span className="k-pulse" data-tone={socketTone} aria-hidden="true" />
                WebSocket: {connectionLabel(watch.connection, watch.attempt)}
              </span>
            )}
          </div>
        </>
      )}
    </footer>
  );
}
