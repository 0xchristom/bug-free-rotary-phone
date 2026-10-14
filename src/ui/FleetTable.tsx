import { memo, useId, useState, type ReactNode } from 'react';
import { addressUrl, transactionUrl, type Explorer, type Network } from '../core/network.ts';
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
import { rowState, type RowState } from './fleet-math.ts';
import { shortAddress } from './short-address.ts';
import { formatSol, formatUnits, parseSolAmount } from './sol.ts';
import type { BuyRow } from './use-buy.ts';
import {
  Avatar,
  Checkbox,
  Chip,
  CopyIcon,
  ExternalIcon,
  IconButton,
  InfoIcon,
  NumberInput,
  PlayIcon,
  Popover,
  QrIcon,
  SolIcon,
  cx,
  type Tone,
} from './kit/index.ts';

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
  /** Selected wallets take part in commands; saved as the `active` flag. */
  readonly selected: boolean;
  readonly minReserve: bigint;
  readonly onMaxSpend: (index: number, text: string) => void;
  readonly onSelect: (index: number, selected: boolean) => void;
  readonly onCopy: (index: number, address: string) => void;
  /** Test hook: called on every render of the row. */
  readonly probe?: ((index: number) => void) | undefined;
  /** This wallet's progress; the same object until its next event (memo). */
  readonly buy: BuyRow | null;
  readonly decimals: number | null;
  readonly explorer: Explorer;
  readonly network: Network;
  /** Buys with this wallet alone (BUNNDLY-59); absent: no row action. */
  readonly onBuy?: ((index: number) => void) | undefined;
  /** Why no buy can start now (the same for every row), or null. */
  readonly buyBlocked: string | null;
}

/** Shown where there is no value yet. */
const NONE = '—';
const COLUMNS = 7;

const STATE_LABELS: Record<WalletState, string> = {
  IDLE: 'Waiting',
  QUEUED: 'Queued',
  QUOTING: 'Quoting',
  SIGNING: 'Signing',
  SUBMITTED: 'Sent',
  CONFIRMED: 'Bought',
  FAILED: 'Failed',
  UNKNOWN: 'Unknown',
  SKIPPED: 'Skipped',
};

function stateLabel(row: BuyRow): string {
  if (row.state === 'UNKNOWN' && row.reason?.code === 'EXECUTE_NO_ANSWER') {
    return 'Checking the chain';
  }
  if (row.state === 'SKIPPED' && row.reason?.code === 'DRY_RUN') return 'DRY-RUN';
  return STATE_LABELS[row.state];
}

/** Tone of the state chip; the text says the same, colour is never the only signal. */
function stateTone(row: BuyRow): Tone {
  if (row.state === 'CONFIRMED') return 'ok';
  if (row.state === 'FAILED') return 'danger';
  if (row.state === 'UNKNOWN') return 'warn';
  if (row.state === 'SKIPPED') return row.reason?.code === 'DRY_RUN' ? 'sim' : 'muted';
  return 'run';
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
  MATCH: 'confirmed',
  INCREASED: 'balance grew',
  MISMATCH: 'different amount',
  NO_INCREASE: 'no increase',
  UNVERIFIABLE: 'not checked',
};

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

function tokens(amount: bigint, decimals: number | null): string {
  return decimals === null ? amount.toString() : formatUnits(amount, decimals);
}

/** What the wallet would do on a buy, before any buy started. */
function idleStatus(
  state: RowState,
  selected: boolean,
  balance: bigint | null,
  maxSpend: bigint | null,
): { readonly text: string; readonly tone: Tone } {
  if (!selected) return { text: 'Not selected', tone: 'muted' };
  if (maxSpend === null || maxSpend === 0n) return { text: 'No amount', tone: 'muted' };
  if (balance === null) return { text: 'No balance yet', tone: 'muted' };
  if (state.reserveTooLow) return { text: 'Low reserve', tone: 'danger' };
  return { text: 'Ready', tone: 'ok' };
}

/** DRY-RUN says it in the chip already; other reasons explain the state. */
function whyOf(buy: BuyRow | null): string | null {
  if (buy === null || buy.reason?.code === 'DRY_RUN') return null;
  return reasonText(buy.reason);
}

function Detail({ term, children }: { readonly term: string; readonly children: ReactNode }) {
  return (
    <div>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** The expanded row: the full address, the reserve and everything known about the buy. */
function Details({
  label,
  address,
  reserve,
  buy,
  decimals,
  explorer,
  network,
}: {
  readonly label: string;
  readonly address: string;
  readonly reserve: bigint | null;
  readonly buy: BuyRow | null;
  readonly decimals: number | null;
  readonly explorer: Explorer;
  readonly network: Network;
}) {
  const result = buy?.result ?? null;
  const quote = buy?.quote ?? null;
  const received = result?.totalOutputAmount ?? null;
  const spent = result?.totalInputAmount ?? null;
  const price =
    received !== null && spent !== null && decimals !== null
      ? formatPrice(spent, received, decimals)
      : null;
  const why = whyOf(buy);
  const url = result?.signature ? transactionUrl(explorer, network, result.signature) : null;
  const verify = buy?.verify ?? null;
  const warn = verify === 'MISMATCH' || verify === 'NO_INCREASE';
  return (
    <dl className="details" aria-label={`Details of ${label}`}>
      <Detail term="Deposit address">
        <code className="address">{address}</code>
      </Detail>
      <Detail term="Reserve (SOL)">
        {reserve === null ? NONE : formatSol(reserve < 0n ? 0n : reserve)}
      </Detail>
      <Detail term="Time">{buy === null ? NONE : seconds(buy.sinceStartMs)}</Detail>
      <Detail term="Attempts">{buy === null ? NONE : buy.attempt}</Detail>
      <Detail term="Bought">
        {received !== null ? (
          tokens(received, decimals)
        ) : quote && buy?.reason?.code === 'DRY_RUN' ? (
          <span className="muted" title="Quote from /order in DRY-RUN mode">
            ≈ {tokens(quote.outAmount, decimals)}
          </span>
        ) : (
          NONE
        )}
      </Detail>
      <Detail term="Spent (SOL)">{spent === null ? NONE : formatSol(spent)}</Detail>
      <Detail term="Price (SOL/token)">{price ?? NONE}</Detail>
      <Detail term="Chain">
        {verify === null ? (
          NONE
        ) : (
          <Chip
            size="sm"
            tone={warn ? 'danger' : verify === 'UNVERIFIABLE' ? 'warn' : 'ok'}
            title={VERIFY_MESSAGES[verify]}
          >
            {VERIFY_LABELS[verify]}
          </Chip>
        )}
      </Detail>
      <Detail term="Transaction">
        {url ? (
          <a href={url} target="_blank" rel="noopener noreferrer">
            Transaction
          </a>
        ) : (
          NONE
        )}
      </Detail>
      {why && <Detail term="Reason">{why}</Detail>}
    </dl>
  );
}

/**
 * One wallet. Memoized with primitive props (bigint compares by value), so a balance
 * refresh re-renders only the rows whose numbers changed.
 */
const FleetRow = memo(function FleetRow(p: RowProps) {
  p.probe?.(p.index);
  const detailsId = useId();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const input = p.maxSpendText.trim() === '' ? null : parseSolAmount(p.maxSpendText);
  const maxSpend = input?.ok ? input.lamports : null;
  const state = rowState({
    balance: p.balance,
    maxSpend,
    minReserve: p.minReserve,
    active: p.selected,
  });
  const rowClass = state.reserveTooLow ? 'row-error' : state.ready ? 'row-ready' : null;
  const explorerUrl = addressUrl(p.explorer, p.network, p.address);
  const idle = idleStatus(state, p.selected, p.balance, maxSpend);
  const why = whyOf(p.buy);
  const rowBuyBlocked =
    p.buyBlocked ??
    (state.ready ? null : 'This wallet is not ready: ' + idle.text.toLowerCase() + '.');
  const amountError =
    input !== null && !input.ok
      ? input.message
      : state.overBalance
        ? 'More than the wallet balance.'
        : state.reserveTooLow && state.reserve !== null
          ? `Leaves ${formatSol(state.reserve)} SOL; the minimum reserve is ${formatSol(p.minReserve)} SOL.`
          : null;
  return (
    <>
      <tr className={cx(rowClass, !p.selected && 'unsel')} data-ready={state.ready}>
        <td className="c-check">
          <Checkbox
            aria-label={`Select ${p.label}`}
            checked={p.selected}
            onChange={(checked) => {
              p.onSelect(p.index, checked);
            }}
          />
        </td>
        <td>
          <div className="w">
            <Avatar seed={p.address} />
            <div>
              <b className="w-name">{p.label}</b>
              <span className="addr">
                <span className="mono" title={p.address}>
                  {shortAddress(p.address)}
                </span>
                <IconButton
                  size="tiny"
                  label={`Copy address ${p.label}`}
                  icon={<CopyIcon />}
                  onClick={() => {
                    p.onCopy(p.index, p.address);
                  }}
                />
                {explorerUrl && (
                  <a
                    className="k-iconbtn k-iconbtn-neutral k-iconbtn-tiny"
                    href={explorerUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`Open ${p.label} in the explorer`}
                    title={`Open ${p.label} in the explorer`}
                  >
                    <ExternalIcon />
                  </a>
                )}
              </span>
            </div>
          </div>
        </td>
        <td>
          {p.balance === null ? (
            NONE
          ) : (
            <span className="bal">
              <SolIcon />
              {formatSol(p.balance)}
            </span>
          )}
        </td>
        <td className="num">{p.token ?? NONE}</td>
        <td>
          <NumberInput
            unit="SOL"
            className="amount-input"
            aria-label={`Max spend ${p.label}`}
            value={p.maxSpendText}
            invalid={input !== null && !input.ok}
            onChange={(e) => {
              p.onMaxSpend(p.index, e.target.value);
            }}
          />
          {amountError && <p className="field-error">{amountError}</p>}
        </td>
        <td>
          {p.buy === null ? (
            <Chip tone={idle.tone}>{idle.text}</Chip>
          ) : (
            <Chip tone={stateTone(p.buy)} dot={stateTone(p.buy) === 'run'}>
              {stateLabel(p.buy)}
            </Chip>
          )}
          {why && (
            <p className="cap" title={why}>
              {why}
            </p>
          )}
        </td>
        <td className="c-acts">
          <div className="acts">
            {p.onBuy && (
              <IconButton
                size="sm"
                variant="success"
                label={`Buy ${p.label}`}
                icon={<PlayIcon />}
                disabled={rowBuyBlocked !== null}
                aria-description={rowBuyBlocked ?? undefined}
                onClick={() => {
                  p.onBuy?.(p.index);
                }}
              />
            )}
            <Popover
              open={qrOpen}
              onClose={() => {
                setQrOpen(false);
              }}
              label={`QR code of ${p.label}`}
              className="qr-pop"
              trigger={
                <IconButton
                  size="sm"
                  label={`QR code ${p.label}`}
                  icon={<QrIcon />}
                  aria-expanded={qrOpen}
                  onClick={() => {
                    setQrOpen((open) => !open);
                  }}
                />
              }
            >
              <AddressQr address={p.address} />
              <b>{p.label}</b>
              <code className="address">{p.address}</code>
            </Popover>
            <IconButton
              size="sm"
              label={`Details ${p.label}`}
              icon={<InfoIcon />}
              aria-expanded={detailsOpen}
              aria-controls={detailsOpen ? detailsId : undefined}
              onClick={() => {
                setDetailsOpen((open) => !open);
              }}
            />
          </div>
        </td>
      </tr>
      {detailsOpen && (
        <tr className="detail" id={detailsId}>
          <td colSpan={COLUMNS}>
            <Details
              label={p.label}
              address={p.address}
              reserve={state.reserve}
              buy={p.buy}
              decimals={p.decimals}
              explorer={p.explorer}
              network={p.network}
            />
          </td>
        </tr>
      )}
    </>
  );
});

export interface FleetTableProps {
  readonly wallets: readonly FleetRowData[];
  readonly lamports: ReadonlyMap<number, bigint> | null;
  readonly tokenAmounts: ReadonlyMap<number, string> | null;
  readonly tokenLabel: string | null;
  readonly maxSpendText: Readonly<Record<number, string>>;
  /** Wallets without an entry are selected (D-019). */
  readonly selected: Readonly<Record<number, boolean>>;
  readonly minReserve: bigint;
  readonly onMaxSpend: RowProps['onMaxSpend'];
  readonly onSelect: RowProps['onSelect'];
  readonly onSelectAll: (selected: boolean) => void;
  readonly onCopy: RowProps['onCopy'];
  readonly probe?: RowProps['probe'];
  /** Progress of the current buy, or null before the first one (BUNNDLY-27). */
  readonly buy?: ReadonlyMap<number, BuyRow> | null;
  /** Decimals of the bought token. */
  readonly buyDecimals?: number | null;
  readonly explorer?: Explorer;
  /** Explorer links lead to this network's pages. */
  readonly network?: Network;
  /** Controls on the right of the bar above the table. */
  readonly tools?: ReactNode;
  /** Row action "Buy" with that wallet alone (BUNNDLY-59). */
  readonly onBuyWallet?: (index: number) => void;
  /** Why no buy can start now, for every row; null when rows may buy. */
  readonly rowBuyBlocked?: string | null;
}

/**
 * Wallet table (SPEC 11.2): one 56 px row per wallet; the buy details of a wallet open in a
 * row under it (SPEC 3.6).
 */
export function FleetTable(t: FleetTableProps) {
  const decimals = t.buyDecimals ?? null;
  const explorer = t.explorer ?? 'solscan';
  const network = t.network ?? 'mainnet';
  const selectedCount = t.wallets.filter((w) => t.selected[w.index] ?? true).length;
  const all = selectedCount === t.wallets.length;
  return (
    <div className="wallets-block">
      <div className="table-bar">
        <span className="sel-count" aria-live="polite">
          {selectedCount} of {t.wallets.length} selected
        </span>
        <span className="spacer" />
        {t.tools}
      </div>
      <div className="wallets-wrap">
        <table className="wallets">
          <caption className="sr-only">
            Wallets (addresses verified; reserve = balance − max spend, minimum{' '}
            {formatSol(t.minReserve)} SOL)
          </caption>
          <thead>
            <tr>
              <th scope="col" className="c-check">
                <Checkbox
                  aria-label="Select all wallets"
                  checked={selectedCount === 0 ? false : all ? true : 'mixed'}
                  disabled={t.wallets.length === 0}
                  onChange={t.onSelectAll}
                />
              </th>
              <th scope="col">Wallet</th>
              <th scope="col" aria-label="Balance (SOL)">
                Balance
              </th>
              <th scope="col">{t.tokenLabel ?? 'Token'}</th>
              <th scope="col" aria-label="Amount (max spend, SOL)">
                Amount
              </th>
              <th scope="col">Status</th>
              <th scope="col" className="c-acts">
                <span className="sr-only">Wallet tools</span>
              </th>
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
                selected={t.selected[w.index] ?? true}
                minReserve={t.minReserve}
                onMaxSpend={t.onMaxSpend}
                onSelect={t.onSelect}
                onCopy={t.onCopy}
                probe={t.probe}
                buy={t.buy?.get(w.index) ?? null}
                decimals={decimals}
                explorer={explorer}
                network={network}
                onBuy={t.onBuyWallet}
                buyBlocked={t.rowBuyBlocked ?? null}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
