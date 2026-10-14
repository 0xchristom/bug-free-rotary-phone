import type { ReactNode } from 'react';
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

function sinceStart(ms: number): string {
  return ms < 1000 ? `+${String(Math.round(ms))} ms` : `+${(ms / 1000).toFixed(1)} s`;
}

/**
 * Totals over the fleet under the table (SPEC 11.2, mockup v2). The fleet fill segments come
 * with the fill bar (BUNNDLY-56).
 */
export function FleetSummaryBar({
  summary,
  walletCount,
  selectedCount,
  tokenDecimals,
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
        <dd>
          <SolIcon />
          {formatSol(summary.totalLamports)}
          <span className="sr-only"> SOL</span>
        </dd>
      </div>
      <div>
        <dt>Planned buy</dt>
        <dd>
          <SolIcon />
          {formatSol(summary.toSpendLamports)}
          <span className="sr-only"> SOL</span>
        </dd>
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
