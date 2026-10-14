import { useState } from 'react';
import type { WatchDetection } from '../watcher/watch.ts';
import { shortAddress } from './short-address.ts';
import { PATH_LABELS, SOURCE_LABELS, problemLabel } from './watch-labels.ts';
import { Button } from './kit/index.ts';

/** One group's detections, with the mints waiting for its running buy. */
export interface GroupDetections {
  readonly group: string;
  readonly detections: readonly WatchDetection[];
  readonly queued: readonly string[];
}

function verifiedLabel(d: WatchDetection): string {
  if (d.verified === true) return 'verified';
  if (d.verified === false) return 'does not match the transaction';
  return '–';
}

/**
 * What the watchers found this session (SPEC 3.4, BUNNDLY-35), newest first, on the
 * Activity screen (BUNNDLY-73): time, mint with copy, group, source, path, reaction,
 * the check against the transaction and what came of it.
 */
export function DetectionsTable({ groups }: { readonly groups: readonly GroupDetections[] }) {
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rows = groups
    .flatMap((g) =>
      g.detections.map((d) => ({ d, group: g.group, queued: g.queued.includes(d.mint) })),
    )
    .sort((a, b) => b.d.detectedAt - a.d.detectedAt);

  const copy = async (mint: string): Promise<void> => {
    setError(null);
    try {
      await navigator.clipboard.writeText(mint);
      setCopied(mint);
    } catch {
      setCopied(null);
      setError('The address could not be copied. Select it and copy it by hand.');
    }
  };

  if (rows.length === 0) {
    return <p className="muted">No detections yet. Arm the watcher on a creator wallet.</p>;
  }
  return (
    <>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      <div className="table-wrap">
        <table className="detections">
          <caption>Detections</caption>
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Mint</th>
              <th scope="col">Group</th>
              <th scope="col">Source</th>
              <th scope="col">Path</th>
              <th scope="col">Reaction</th>
              <th scope="col">Verification</th>
              <th scope="col">Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ d, group, queued }) => (
              <tr key={`${group}-${d.mint}-${d.signature}`}>
                <td>{new Date(d.detectedAt).toLocaleTimeString('en-GB')}</td>
                <td>
                  <code title={d.mint}>{shortAddress(d.mint)}</code>{' '}
                  <Button
                    size="sm"
                    aria-label={`Copy mint ${d.mint}`}
                    onClick={() => void copy(d.mint)}
                  >
                    {copied === d.mint ? 'Copied' : 'Copy'}
                  </Button>
                </td>
                <td>{group}</td>
                <td>{SOURCE_LABELS[d.source]}</td>
                <td>{PATH_LABELS[d.path]}</td>
                <td>{d.reactionMs === null ? '–' : `${String(Math.round(d.reactionMs))} ms`}</td>
                <td className={d.verified === false ? 'danger' : undefined}>{verifiedLabel(d)}</td>
                <td>
                  {d.problem !== null
                    ? problemLabel(d.problem)
                    : queued
                      ? 'queued'
                      : d.runId !== null
                        ? `buy #${String(d.runId)}`
                        : 'buy starting…'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
