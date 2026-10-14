import { useId } from 'react';
import type { StorageEnv } from '../../storage/keystore-file.ts';
import type { VaultInfo } from '../../worker/protocol.ts';
import { effectiveGroups } from '../../core/groups.ts';
import { DetectionsTable, type GroupDetections } from '../DetectionsTable.tsx';
import type { OperationsLog } from '../operations-log.ts';
import { OperationsLogPanel } from '../OperationsLogPanel.tsx';
import { useVault } from '../vault-state.ts';

export interface ActivityScreenProps {
  readonly info: VaultInfo;
  readonly storage: StorageEnv;
  readonly operationsLog: OperationsLog;
  /** Decimals of the last run's token, for the price column of the log. */
  readonly decimals: number | null;
}

/**
 * Activity (BUNNDLY-73, mockup v2 navigation): what this session did. The operations log
 * of every buy and sell with its downloads (BUNNDLY-25), and the watchers' detections.
 */
export function ActivityScreen({ info, storage, operationsLog, decimals }: ActivityScreenProps) {
  const ids = useId();
  const { status } = useVault();
  const names = new Map(
    effectiveGroups(
      info.settings.groups,
      info.wallets.map((w) => w.index),
    ).map((g) => [g.id, g.name]),
  );
  const detections: GroupDetections[] = (status?.groups ?? []).flatMap((g) =>
    g.watch === null
      ? []
      : [
          {
            group: names.get(g.id) ?? g.id,
            detections: g.watch.detections,
            queued: g.watch.queued,
          },
        ],
  );
  return (
    <section className="screen" aria-labelledby={`${ids}-title`}>
      <h2 id={`${ids}-title`}>Activity</h2>
      <OperationsLogPanel log={operationsLog} storage={storage} decimals={decimals} />
      <section aria-labelledby={`${ids}-det`}>
        <h3 id={`${ids}-det`}>Watcher detections</h3>
        <DetectionsTable groups={detections} />
      </section>
    </section>
  );
}
