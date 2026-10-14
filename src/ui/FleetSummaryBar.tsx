import type { ReactNode } from 'react';
import type { FillTone } from './fill.ts';
import type { FleetSummary } from './fleet-math.ts';
import { formatSol, formatUnits } from './sol.ts';
import { SolIcon } from './kit/index.ts';

export interface FleetSummaryBarProps {
  readonly summary: FleetSummary;
  readonly walletCount: number;
  /** Wallets that take part in commands. */
  readonly selectedCount: number;
  /** Decimals of the shown token, or null when no token is shown. */
  readonly tokenDecimals: number | null;
  /** False until the first SOL balance read: the sums are unknown, not 0 (BUNNDLY-81). */
  readonly balancesRead?: boolean;
  /** Since the start of the last buy: its first and its last confirmed wallet. */
  readonly firstFillMs: number | null;
  readonly lastFillMs: number | null;
  /** What the fill times count from: the start of the run, or the detection (mode B). */
  readonly fillFrom?: 'start' | 'detection';
  /**
   * The run in progress or the last one, as in the mockup: "Fleet fill · 4 of 10 filled ·
   * 1 in flight · 1 failed" over its bar (BUNNDLY-73).
   */
  readonly fill?: { readonly text: string; readonly bar: ReactNode } | null;
}

/**
 * The fleet fill bar (mockup v2 `.segs`): one segment per selected wallet in the tone of its
 * Fill (`fillOf`), so the colours match the rows. The text above it gives the counts.
 */
export function FleetSegments({ tones }: { readonly tones: readonly FillTone[] }) {
  return (
    <div className="segs" aria-hidden="true" data-testid="fleet-segments">
      {tones.map((tone, k) => (
        <i key={k} data-tone={tone} />
      ))}
    </div>
  );
}

function Sol({ lamports }: { readonly lamports: bigint }) {
  return (
    <>
      <SolIcon />
      {formatSol(lamports)}
      <span className="sr-only"> SOL</span>
    </>
  );
}

function sinceStart(ms: number): string {
  return ms < 1000 ? `+${String(Math.round(ms))} ms` : `+${(ms / 1000).toFixed(1)} s`;
}

/**
 * Totals over the fleet under the table (SPEC 11.2, mockup v2). The fleet fill text and its
 * segments come from `fleetFill` (BUNNDLY-56).
 */
export function FleetSummaryBar({
  summary,
  walletCount,
  selectedCount,
  tokenDecimals,
  balancesRead = true,
  firstFillMs,
  lastFillMs,
  fillFrom = 'start',
  fill = null,
}: FleetSummaryBarProps) {
  return (
    <dl className="summary" aria-label="Fleet summary">
      <div>
        <dt>Selected</dt>
        <dd>
          {selectedCount} of {walletCount}
        </dd>
      </div>
      <div>
        <dt>Fleet balance</dt>
        <dd>{balancesRead ? <Sol lamports={summary.totalLamports} /> : '—'}</dd>
      </div>
      <div>
        <dt>Planned buy</dt>
        <dd>{balancesRead ? <Sol lamports={summary.toSpendLamports} /> : '—'}</dd>
      </div>
      <div className="wide">
        <dt role="status" aria-live="polite">
          {fill?.text ?? 'Fleet fill · no buy or sell yet'}
        </dt>
        <dd>{fill?.bar}</dd>
      </div>
      <div>
        <dt>Tokens held</dt>
        <dd>
          {summary.totalToken === null || tokenDecimals === null
            ? '—'
            : formatUnits(summary.totalToken, tokenDecimals)}
        </dd>
      </div>
      <div>
        <dt>First and last fill</dt>
        <dd
          title={fillFrom === 'detection' ? 'Counted from the detection' : 'Counted from the start'}
        >
          {firstFillMs === null || lastFillMs === null
            ? '—'
            : `${sinceStart(firstFillMs)} · ${sinceStart(lastFillMs)}`}
        </dd>
      </div>
    </dl>
  );
}
