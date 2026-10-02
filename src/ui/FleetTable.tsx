import { memo } from 'react';
import { AddressQr } from './AddressQr.tsx';
import { rowState } from './fleet-math.ts';
import { formatSol, parseSolAmount } from './sol.ts';

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
}

/** Fleet table (SPEC 3.2) without the purchase columns (sprint 3). */
export function FleetTable(t: FleetTableProps) {
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
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
