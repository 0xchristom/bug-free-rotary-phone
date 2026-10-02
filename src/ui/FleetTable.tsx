import { memo } from 'react';
import type { Explorer } from '../core/settings.ts';
import { formatPrice } from '../executor/oplog.ts';
import {
  FAIL_MESSAGES,
  SKIP_MESSAGES,
  UNKNOWN_MESSAGES,
  type WalletReason,
  type WalletState,
} from '../executor/states.ts';
import { VERIFY_MESSAGES, type VerifyStatus } from '../executor/verify.ts';
import { AddressQr } from './AddressQr.tsx';
import { transactionUrl } from './explorer.ts';
import { rowState } from './fleet-math.ts';
import { formatSol, formatUnits, parseSolAmount } from './sol.ts';
import type { BuyRow } from './use-buy.ts';

export interface FleetRowData {
  readonly index: number;
  readonly label: string;
  /** Verified by the vault on unlock (D-018): copy and QR only here. */
  readonly address: string;
}

interface RowProps extends FleetRowData {
  readonly balance: bigint | null;
  /** Token balance already formatted with its decimals, or null. */
  readonly token: string | null;
  readonly maxSpendText: string;
  readonly active: boolean;
  readonly minReserve: bigint;
  readonly qrOpen: boolean;
  readonly copied: boolean;
  readonly onMaxSpend: (index: number, text: string) => void;
  readonly onActive: (index: number, active: boolean) => void;
  readonly onCopy: (index: number, address: string) => void;
  readonly onQr: (index: number) => void;
  /** Test hook: called on every render of the row. */
  readonly probe?: ((index: number) => void) | undefined;
  /** Purchase columns are shown once a buy started (BUNNDLY-27). */
  readonly showBuy: boolean;
  /** This wallet's progress; the same object until its next event (memo). */
  readonly buy: BuyRow | null;
  readonly decimals: number | null;
  readonly explorer: Explorer;
}

const STATE_LABELS: Record<WalletState, string> = {
  IDLE: 'Czeka',
  QUEUED: 'W kolejce',
  QUOTING: 'Wycena',
  SIGNING: 'Podpis',
  SUBMITTED: 'Wysłano',
  CONFIRMED: 'Kupiono',
  FAILED: 'Nieudany',
  UNKNOWN: 'Nieznany',
  SKIPPED: 'Pominięty',
};

function stateLabel(row: BuyRow): string {
  if (row.state === 'UNKNOWN' && row.reason?.code === 'EXECUTE_NO_ANSWER') {
    return 'Sprawdzam łańcuch';
  }
  if (row.state === 'SKIPPED' && row.reason?.code === 'DRY_RUN') return 'DRY-RUN';
  return STATE_LABELS[row.state];
}

/** Colour class; the text says the same, colour is never the only signal. */
function stateTone(row: BuyRow): string {
  if (row.state === 'CONFIRMED') return 'ok';
  if (row.state === 'FAILED') return 'danger';
  if (row.state === 'UNKNOWN') return 'warning';
  if (row.state === 'SKIPPED') return row.reason?.code === 'DRY_RUN' ? 'info' : 'muted';
  return 'busy';
}

function reasonText(reason: WalletReason | null): string | null {
  if (reason === null) return null;
  switch (reason.kind) {
    case 'SKIPPED':
      return SKIP_MESSAGES[reason.code];
    case 'FAILED':
      return FAIL_MESSAGES[reason.code];
    case 'UNKNOWN':
      return UNKNOWN_MESSAGES[reason.code];
  }
}

const VERIFY_LABELS: Record<VerifyStatus, string> = {
  MATCH: 'potwierdzone',
  INCREASED: 'saldo wzrosło',
  MISMATCH: 'inna ilość',
  NO_INCREASE: 'brak wzrostu',
  UNVERIFIABLE: 'nie sprawdzono',
};

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1).replace('.', ',')} s`;
}

function tokens(amount: bigint, decimals: number | null): string {
  return decimals === null ? amount.toString() : formatUnits(amount, decimals);
}

function BuyCells({
  buy,
  decimals,
  explorer,
}: {
  readonly buy: BuyRow | null;
  readonly decimals: number | null;
  readonly explorer: Explorer;
}) {
  if (buy === null) {
    return (
      <>
        <td>–</td>
        <td className="amount">–</td>
        <td className="amount">–</td>
        <td className="amount">–</td>
        <td className="amount">–</td>
        <td className="amount">–</td>
        <td>–</td>
        <td>–</td>
      </>
    );
  }
  const { result, quote } = buy;
  const received = result?.totalOutputAmount ?? null;
  const spent = result?.totalInputAmount ?? null;
  const price =
    received !== null && spent !== null && decimals !== null
      ? formatPrice(spent, received, decimals)
      : null;
  // DRY-RUN says it in the badge already; other reasons explain the state.
  const why = buy.reason?.code === 'DRY_RUN' ? null : reasonText(buy.reason);
  const url = result?.signature ? transactionUrl(explorer, result.signature) : null;
  const warn = buy.verify === 'MISMATCH' || buy.verify === 'NO_INCREASE';
  return (
    <>
      <td>
        <span className={`badge state ${stateTone(buy)}`}>{stateLabel(buy)}</span>
        {why && <p className="reason">{why}</p>}
      </td>
      <td className="amount">{seconds(buy.sinceStartMs)}</td>
      <td className="amount">{buy.attempt}</td>
      <td className="amount">
        {received !== null ? (
          tokens(received, decimals)
        ) : quote && buy.reason?.code === 'DRY_RUN' ? (
          <span className="muted" title="Wycena z /order w trybie DRY-RUN">
            ≈ {tokens(quote.outAmount, decimals)}
          </span>
        ) : (
          '–'
        )}
      </td>
      <td className="amount">{spent === null ? '–' : formatSol(spent)}</td>
      <td className="amount">{price ?? '–'}</td>
      <td>
        {buy.verify === null ? (
          '–'
        ) : (
          <span
            className={`badge ${warn ? 'danger' : buy.verify === 'UNVERIFIABLE' ? 'unverified' : 'ok'}`}
            title={VERIFY_MESSAGES[buy.verify]}
          >
            {VERIFY_LABELS[buy.verify]}
          </span>
        )}
      </td>
      <td>
        {url ? (
          <a href={url} target="_blank" rel="noopener noreferrer">
            Transakcja
          </a>
        ) : (
          '–'
        )}
      </td>
    </>
  );
}

/**
 * One wallet. Memoized with primitive props (bigint compares by value), so a balance
 * refresh re-renders only the rows whose numbers changed.
 */
const FleetRow = memo(function FleetRow(p: RowProps) {
  p.probe?.(p.index);
  const input = p.maxSpendText.trim() === '' ? null : parseSolAmount(p.maxSpendText);
  const maxSpend = input?.ok ? input.lamports : null;
  const state = rowState({
    balance: p.balance,
    maxSpend,
    minReserve: p.minReserve,
    active: p.active,
  });
  const rowClass = state.reserveTooLow ? 'row-error' : state.ready ? 'row-ready' : undefined;
  return (
    <tr className={rowClass} data-ready={state.ready}>
      <td>{p.index + 1}</td>
      <td>{p.label}</td>
      <td>
        <code className="address">{p.address}</code>
        {p.qrOpen && (
          <div className="qr-box">
            <AddressQr address={p.address} />
          </div>
        )}
      </td>
      <td className="amount">{p.balance === null ? '–' : formatSol(p.balance)}</td>
      <td>
        <input
          className="amount-input"
          type="text"
          inputMode="decimal"
          aria-label={`Max spend ${p.label}`}
          value={p.maxSpendText}
          aria-invalid={input !== null && !input.ok}
          onChange={(e) => {
            p.onMaxSpend(p.index, e.target.value);
          }}
        />
        {input !== null && !input.ok && <p className="field-error">{input.message}</p>}
        {state.overBalance && <p className="field-error">Więcej niż saldo portfela.</p>}
      </td>
      <td className="amount">
        {state.reserve === null ? '–' : formatSol(state.reserve < 0n ? 0n : state.reserve)}
        {state.reserveTooLow && (
          <span className="badge danger" title="Rezerwa poniżej MIN_RESERVE_SOL">
            za mała
          </span>
        )}
      </td>
      <td className="amount">{p.token ?? '–'}</td>
      <td>
        <input
          type="checkbox"
          aria-label={`Aktywny ${p.label}`}
          checked={p.active}
          onChange={(e) => {
            p.onActive(p.index, e.target.checked);
          }}
        />
      </td>
      {p.showBuy && <BuyCells buy={p.buy} decimals={p.decimals} explorer={p.explorer} />}
      <td>
        <button
          type="button"
          aria-label={`Kopiuj adres ${p.label}`}
          onClick={() => {
            p.onCopy(p.index, p.address);
          }}
        >
          {p.copied ? 'Skopiowano' : 'Kopiuj'}
        </button>{' '}
        <button
          type="button"
          aria-label={`Kod QR ${p.label}`}
          aria-expanded={p.qrOpen}
          onClick={() => {
            p.onQr(p.index);
          }}
        >
          QR
        </button>
      </td>
    </tr>
  );
});

export interface FleetTableProps {
  readonly wallets: readonly FleetRowData[];
  readonly lamports: ReadonlyMap<number, bigint> | null;
  readonly tokenAmounts: ReadonlyMap<number, string> | null;
  readonly tokenLabel: string | null;
  readonly maxSpendText: Readonly<Record<number, string>>;
  readonly active: Readonly<Record<number, boolean>>;
  readonly minReserve: bigint;
  readonly qrFor: number | null;
  readonly copied: number | null;
  readonly onMaxSpend: RowProps['onMaxSpend'];
  readonly onActive: RowProps['onActive'];
  readonly onCopy: RowProps['onCopy'];
  readonly onQr: RowProps['onQr'];
  readonly probe?: RowProps['probe'];
  /** Progress of the current buy, or null before the first one (BUNNDLY-27). */
  readonly buy?: ReadonlyMap<number, BuyRow> | null;
  /** Decimals of the bought token. */
  readonly buyDecimals?: number | null;
  readonly explorer?: Explorer;
}

/** Fleet table (SPEC 3.2), with the purchase columns once a buy started (SPEC 3.6). */
export function FleetTable(t: FleetTableProps) {
  const showBuy = t.buy !== undefined && t.buy !== null;
  const decimals = t.buyDecimals ?? null;
  const explorer = t.explorer ?? 'solscan';
  return (
    <div className="table-wrap">
      <table className="wallets">
        <caption>
          Portfele (adresy zweryfikowane; rezerwa = saldo − max spend, minimum{' '}
          {formatSol(t.minReserve)} SOL)
        </caption>
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Etykieta</th>
            <th scope="col">Adres depozytu</th>
            <th scope="col">Saldo SOL</th>
            <th scope="col">Max spend (SOL)</th>
            <th scope="col">Rezerwa (SOL)</th>
            <th scope="col">{t.tokenLabel ?? 'Token'}</th>
            <th scope="col">Aktywny</th>
            {showBuy && (
              <>
                <th scope="col">Status zakupu</th>
                <th scope="col">Czas</th>
                <th scope="col">Próby</th>
                <th scope="col">Kupione</th>
                <th scope="col">Wydano (SOL)</th>
                <th scope="col">Cena (SOL/token)</th>
                <th scope="col">Łańcuch</th>
                <th scope="col">Transakcja</th>
              </>
            )}
            <th scope="col">Akcje</th>
          </tr>
        </thead>
        <tbody>
          {t.wallets.map((w) => (
            <FleetRow
              key={w.index}
              index={w.index}
              label={w.label}
              address={w.address}
              balance={t.lamports?.get(w.index) ?? null}
              token={t.tokenAmounts?.get(w.index) ?? null}
              maxSpendText={t.maxSpendText[w.index] ?? ''}
              active={t.active[w.index] ?? true}
              minReserve={t.minReserve}
              qrOpen={t.qrFor === w.index}
              copied={t.copied === w.index}
              onMaxSpend={t.onMaxSpend}
              onActive={t.onActive}
              onCopy={t.onCopy}
              onQr={t.onQr}
              probe={t.probe}
              showBuy={showBuy}
              buy={t.buy?.get(w.index) ?? null}
              decimals={decimals}
              explorer={explorer}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
