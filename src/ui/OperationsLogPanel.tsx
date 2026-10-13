import { useId, useState } from 'react';
import { toUserMessage } from '../core/errors.ts';
import { logFileName, toCsv, toJson } from '../executor/oplog.ts';
import { downloadTextFile, type StorageEnv } from '../storage/keystore-file.ts';
import { useOperationsLogSize, type OperationsLog } from './operations-log.ts';

export interface OperationsLogPanelProps {
  readonly log: OperationsLog;
  readonly storage: StorageEnv;
  /** Decimals of the token on screen, for the price column. */
  readonly decimals: number | null;
  readonly now?: () => number;
}

/** Operations log (BUNNDLY-25): how many entries, and download as CSV or JSON. */
export function OperationsLogPanel({
  log,
  storage,
  decimals,
  now = () => Date.now(),
}: OperationsLogPanelProps) {
  const size = useOperationsLogSize(log);
  const titleId = useId();
  const [error, setError] = useState<string | null>(null);

  const save = (format: 'csv' | 'json'): void => {
    setError(null);
    const entries = log.entries(decimals);
    const text = format === 'csv' ? toCsv(entries) : toJson(entries);
    try {
      downloadTextFile(
        storage,
        text,
        logFileName(log.lastRunId() ?? 0, now(), format),
        format === 'csv' ? 'text/csv' : 'application/json',
      );
    } catch (e) {
      setError(toUserMessage(e));
    }
  };

  return (
    <section aria-labelledby={titleId}>
      <h4 id={titleId}>Operations log</h4>
      <p className="muted">
        {size === 0
          ? 'No entries. Every wallet state change in a buy is recorded here.'
          : `Entries: ${String(size)}. No keys and no signed transactions; amounts in lamports and token base units.`}
      </p>
      <div className="actions">
        <button
          type="button"
          disabled={size === 0}
          onClick={() => {
            save('csv');
          }}
        >
          Download CSV
        </button>
        <button
          type="button"
          disabled={size === 0}
          onClick={() => {
            save('json');
          }}
        >
          Download JSON
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
