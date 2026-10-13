import { useId, useState, type SyntheticEvent } from 'react';
import { parsePercent, type FleetSummary } from './fleet-math.ts';
import { formatSol, formatUnits, parseSolAmount } from './sol.ts';
import { Button, Input, SolIcon } from './kit/index.ts';

export interface FleetBulkProps {
  /** Sets the same max spend on every wallet. */
  readonly onAmount: (lamports: bigint) => void;
  /** Sets max spend to a share of each wallet's balance (basis points). */
  readonly onPercent: (basisPoints: number) => void;
  /** Wallets whose balance is not known yet (the % action skips them). */
  readonly unknownBalances: number;
}

/** Bulk actions over the whole table (SPEC 3.2). They only change the drafts. */
export function FleetBulk({ onAmount, onPercent, unknownBalances }: FleetBulkProps) {
  const ids = useId();
  const [amount, setAmount] = useState('');
  const [percent, setPercent] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const applyAmount = (event: SyntheticEvent): void => {
    event.preventDefault();
    const parsed = parseSolAmount(amount);
    if (!parsed.ok) {
      setMessage(parsed.message);
      return;
    }
    setMessage(null);
    onAmount(parsed.lamports);
  };

  const applyPercent = (event: SyntheticEvent): void => {
    event.preventDefault();
    const bp = parsePercent(percent);
    if (bp === null) {
      setMessage('Enter a percent of the balance from 0.01 to 100 (at most 2 decimal places).');
      return;
    }
    setMessage(
      unknownBalances > 0
        ? `Skipped wallets with no balance read: ${String(unknownBalances)}.`
        : null,
    );
    onPercent(bp);
  };

  return (
    <fieldset className="bulk">
      <legend>Bulk actions</legend>
      <form className="inline" onSubmit={applyAmount}>
        <label htmlFor={`${ids}-amount`}>Max spend for all (SOL)</label>
        <Input
          id={`${ids}-amount`}
          className="amount-input"
          inputMode="decimal"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
          }}
        />
        <Button type="submit">Set amount</Button>
      </form>
      <form className="inline" onSubmit={applyPercent}>
        <label htmlFor={`${ids}-percent`}>Max spend as % of balance</label>
        <Input
          id={`${ids}-percent`}
          className="amount-input"
          inputMode="decimal"
          value={percent}
          onChange={(e) => {
            setPercent(e.target.value);
          }}
        />
        <Button type="submit">Set percent</Button>
      </form>
      {message && (
        <p className="field-error" role="status">
          {message}
        </p>
      )}
      <p className="hint">Changes go to the table; save them with “Save table changes”.</p>
    </fieldset>
  );
}

export interface FleetSummaryBarProps {
  readonly summary: FleetSummary;
  readonly walletCount: number;
  /** Wallets that take part in commands. */
  readonly selectedCount: number;
  /** Decimals of the shown token, or null when no token is shown. */
  readonly tokenDecimals: number | null;
}

/** Totals over the fleet (SPEC 11.2). The average entry price comes with purchases. */
export function FleetSummaryBar({
  summary,
  walletCount,
  selectedCount,
  tokenDecimals,
}: FleetSummaryBarProps) {
  return (
    <dl className="summary" aria-label="Fleet summary">
      <div>
        <dt>Selected</dt>
        <dd>
          {selectedCount} / {walletCount}
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
      <div>
        <dt>Ready wallets</dt>
        <dd>
          {summary.readyCount} / {walletCount}
        </dd>
      </div>
      <div>
        <dt>Tokens held</dt>
        <dd>
          {summary.totalToken === null || tokenDecimals === null
            ? '—'
            : formatUnits(summary.totalToken, tokenDecimals)}
        </dd>
      </div>
    </dl>
  );
}
