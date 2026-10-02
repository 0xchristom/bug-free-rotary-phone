import { useId, useState, type SyntheticEvent } from 'react';
import { parsePercent, type FleetSummary } from './fleet-math.ts';
import { formatSol, formatUnits, parseSolAmount } from './sol.ts';

export interface FleetBulkProps {
  /** Sets the same max spend on every wallet. */
  readonly onAmount: (lamports: bigint) => void;
  /** Sets max spend to a share of each wallet's balance (basis points). */
  readonly onPercent: (basisPoints: number) => void;
  readonly onAllActive: (active: boolean) => void;
  /** Wallets whose balance is not known yet (the % action skips them). */
  readonly unknownBalances: number;
}

/** Bulk actions over the whole table (SPEC 3.2). They only change the drafts. */
export function FleetBulk({ onAmount, onPercent, onAllActive, unknownBalances }: FleetBulkProps) {
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
      setMessage('Podaj procent salda od 0,01 do 100 (najwyżej 2 miejsca po przecinku).');
      return;
    }
    setMessage(
      unknownBalances > 0
        ? `Pominięto portfele bez odczytanego salda: ${String(unknownBalances)}.`
        : null,
    );
    onPercent(bp);
  };

  return (
    <fieldset className="bulk">
      <legend>Akcje zbiorcze</legend>
      <form className="inline" onSubmit={applyAmount}>
        <label htmlFor={`${ids}-amount`}>Max spend dla wszystkich (SOL)</label>
        <input
          id={`${ids}-amount`}
          className="amount-input"
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(e) => {
            setAmount(e.target.value);
          }}
        />
        <button type="submit">Ustaw kwotę</button>
      </form>
      <form className="inline" onSubmit={applyPercent}>
        <label htmlFor={`${ids}-percent`}>Max spend jako % salda</label>
        <input
          id={`${ids}-percent`}
          className="amount-input"
          type="text"
          inputMode="decimal"
          value={percent}
          onChange={(e) => {
            setPercent(e.target.value);
          }}
        />
        <button type="submit">Ustaw procent</button>
      </form>
      <div className="inline">
        <button
          type="button"
          onClick={() => {
            onAllActive(true);
          }}
        >
          Zaznacz wszystkie
        </button>
        <button
          type="button"
          onClick={() => {
            onAllActive(false);
          }}
        >
          Odznacz wszystkie
        </button>
      </div>
      {message && (
        <p className="field-error" role="status">
          {message}
        </p>
      )}
      <p className="hint">
        Zmiany trafiają do tabeli; zapisujesz je przyciskiem „Zapisz zmiany w tabeli”.
      </p>
    </fieldset>
  );
}

export interface FleetSummaryBarProps {
  readonly summary: FleetSummary;
  readonly walletCount: number;
  /** Decimals of the shown token, or null when no token is shown. */
  readonly tokenDecimals: number | null;
}

/** Totals over the fleet (SPEC 3.2). The average entry price comes with purchases. */
export function FleetSummaryBar({ summary, walletCount, tokenDecimals }: FleetSummaryBarProps) {
  return (
    <dl className="summary" aria-label="Podsumowanie floty">
      <div>
        <dt>Łącznie SOL</dt>
        <dd>{formatSol(summary.totalLamports)} SOL</dd>
      </div>
      <div>
        <dt>Łącznie do wydania</dt>
        <dd>{formatSol(summary.toSpendLamports)} SOL</dd>
      </div>
      <div>
        <dt>Gotowe portfele</dt>
        <dd>
          {summary.readyCount} / {walletCount}
        </dd>
      </div>
      <div>
        <dt>Łącznie tokenów</dt>
        <dd>
          {summary.totalToken === null || tokenDecimals === null
            ? '–'
            : formatUnits(summary.totalToken, tokenDecimals)}
        </dd>
      </div>
    </dl>
  );
}
