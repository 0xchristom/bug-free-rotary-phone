import { useState } from 'react';
import { toUserMessage } from '../core/errors.ts';
import { NETWORK_LABELS, type Network } from '../core/network.ts';
import { DRY_RUN_NOTE, LIVE_NOTE } from './mode-text.ts';
import { formatSol } from './sol.ts';
import { Button, Modal, cx } from './kit/index.ts';

export interface ModeSwitchProps {
  readonly dryRun: boolean;
  readonly network: Network;
  /** What the next buy would spend, for the confirmation. */
  readonly readyCount: number;
  readonly toSpend: bigint;
  /** Why the mode cannot change now (an armed watcher, a running buy), or null. */
  readonly blocked: string | null;
  /** Saves the mode in the vault; the screen then offers to save the fleet file. */
  readonly onDryRun: (dryRun: boolean) => Promise<void>;
  readonly onError: (message: string) => void;
}

/**
 * The DRY-RUN switch in the top bar (mockup v2). Back to DRY-RUN at once; live mode only
 * through a confirmation with the network, the amount and the wallet count (SPEC 7).
 */
export function ModeSwitch({
  dryRun,
  network,
  readyCount,
  toSpend,
  blocked,
  onDryRun,
  onError,
}: ModeSwitchProps) {
  const [confirmLive, setConfirmLive] = useState(false);
  const [busy, setBusy] = useState(false);

  const setMode = (next: boolean): void => {
    setConfirmLive(false);
    setBusy(true);
    onDryRun(next).then(
      () => {
        setBusy(false);
      },
      (e: unknown) => {
        onError(toUserMessage(e));
        setBusy(false);
      },
    );
  };

  return (
    <>
      <button
        type="button"
        role="switch"
        aria-checked={dryRun}
        className={cx('top-chip', 'switch', dryRun && 'on')}
        disabled={busy || blocked !== null}
        title={blocked ?? (dryRun ? DRY_RUN_NOTE : LIVE_NOTE)}
        aria-description={blocked ?? (dryRun ? DRY_RUN_NOTE : LIVE_NOTE)}
        onClick={() => {
          if (dryRun) setConfirmLive(true);
          else setMode(true);
        }}
      >
        <i aria-hidden="true" />
        DRY-RUN
      </button>
      {/* The switch stays mounted: the dialog gives the focus back to it. */}
      {confirmLive && (
        <Modal
          open
          role="alertdialog"
          tone="danger"
          title="Switch to live mode?"
          onClose={() => {
            setConfirmLive(false);
          }}
          footer={
            <>
              <Button
                variant="ghost"
                onClick={() => {
                  setConfirmLive(false);
                }}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  setMode(false);
                }}
              >
                Yes, switch to live mode
              </Button>
            </>
          }
        >
          <p>
            Network: {NETWORK_LABELS[network]}. The next buy will spend real SOL: up to{' '}
            {formatSol(toSpend)} SOL from {readyCount} {readyCount === 1 ? 'wallet' : 'wallets'}.
            On-chain transactions cannot be undone.
          </p>
        </Modal>
      )}
    </>
  );
}
