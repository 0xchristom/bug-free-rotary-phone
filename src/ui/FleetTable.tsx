import { memo, useCallback, useId, useMemo, useState, type ReactNode } from 'react';
import { addressUrl, transactionUrl, type Explorer, type Network } from '../core/network.ts';
import { walletTrade, type TradeSettingsV1 } from '../core/trade.ts';
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
import { formatSol, formatUnits } from './sol.ts';
import {
  amountLabel,
  amountText,
  feeLabel,
  ownAmount,
  plannedSpend,
  slippageLabel,
  type WalletPatch,
} from './trade-edit.ts';
import type { BuyRow } from './use-buy.ts';
import {
  DEFAULT_SORT,
  WALLET_FILTERS,
  matchesFilter,
  matchesSearch,
  nextSort,
  sortWallets,
  type FilterWallet,
  type Sort,
  type SortKey,
  type WalletFilter,
} from './wallet-filters.ts';
import { AmountField, EditWallet } from './WalletTradeFields.tsx';
import {
  Avatar,
  Checkbox,
  Chip,
  CopyIcon,
  ExternalIcon,
  IconButton,
  InIcon,
  Input,
  OutIcon,
  PlayIcon,
  Popover,
  QrIcon,
  SearchIcon,
  SolIcon,
  SortIcon,
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
  /** The wallet's own buy amount as text and its unit; empty text = the fleet default. */
  readonly amountText: string;
  readonly amountUnit: 'SOL' | '%';
  /** The fleet default amount in words, for the empty field. */
  readonly defaultAmount: string;
  /** What a buy would spend now (a percent counted from the balance), or null. */
  readonly spend: bigint | null;
  /** What the wallet trades with, in words (defaults applied). */
  readonly amountNow: string;
  readonly buySlip: string;
  readonly sellSlip: string;
  readonly buyFee: string;
  readonly sellFee: string;
  readonly sellPart: string;
  /** In a running buy, sell or armed watch of its group: its trade settings stay. */
  readonly locked: boolean;
  /** Selected wallets take part in commands; saved as the `active` flag. */
  readonly selected: boolean;
  readonly minReserve: bigint;
  readonly onTrade: (index: number, patch: WalletPatch) => Promise<string | null>;
  readonly onSelect: (index: number, selected: boolean) => void;
  readonly onCopy: (index: number, address: string) => void;
  /** Test hook: called on every render of the row. */
  readonly probe?: ((index: number) => void) | undefined;
  /** This wallet's progress; the same object until its next event (memo). */
  readonly buy: BuyRow | null;
  readonly explorer: Explorer;
  readonly network: Network;
  /** Buys with this wallet alone (BUNNDLY-59); absent: no row action. */
  readonly onBuy?: ((index: number) => void) | undefined;
  /** Why no buy can start now (the same for every row), or null. */
  readonly buyBlocked: string | null;
}

/** Shown where there is no value yet. */
const NONE = '—';
/** Columns of the table, for the row that says no wallet matches. */
const COLUMNS = 10;

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
  MATCH: 'Chain: confirmed',
  INCREASED: 'Chain: balance grew',
  MISMATCH: 'Chain: different amount',
  NO_INCREASE: 'Chain: no increase',
  UNVERIFIABLE: 'Chain: not checked',
};

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
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

/**
 * The wallet's last message under its state: why it ended as it did, or what the chain
 * check found after a buy. DRY-RUN says it in the chip already.
 */
function lastMessage(buy: BuyRow | null): { readonly text: string; readonly title: string } | null {
  if (buy === null) return null;
  if (buy.verify !== null) {
    return { text: VERIFY_LABELS[buy.verify], title: VERIFY_MESSAGES[buy.verify] };
  }
  if (buy.reason?.code === 'DRY_RUN') return null;
  const why = reasonText(buy.reason);
  return why === null ? null : { text: why, title: why };
}

/** A buy value over a sell value, as the mockup's badges (green in, red out). */
function Pair({
  what,
  buy,
  sell,
}: {
  readonly what: string;
  readonly buy: string;
  readonly sell: string;
}) {
  return (
    <div className="pair">
      <span className="mini b" title={`${what} when buying`}>
        <InIcon />
        {buy}
      </span>
      <span className="mini s" title={`${what} when selling`}>
        <OutIcon />
        {sell}
      </span>
    </div>
  );
}

/**
 * One wallet. Memoized with primitive props (bigint compares by value), so a balance
 * refresh re-renders only the rows whose numbers changed.
 */
const FleetRow = memo(function FleetRow(p: RowProps) {
  p.probe?.(p.index);
  const [qrOpen, setQrOpen] = useState(false);
  const { index, onTrade } = p;
  const save = useCallback((patch: WalletPatch) => onTrade(index, patch), [index, onTrade]);
  const maxSpend = p.spend;
  const state = rowState({
    balance: p.balance,
    maxSpend,
    minReserve: p.minReserve,
    active: p.selected,
  });
  const rowClass = state.reserveTooLow ? 'row-error' : state.ready ? 'row-ready' : null;
  const explorerUrl = addressUrl(p.explorer, p.network, p.address);
  const idle = idleStatus(state, p.selected, p.balance, maxSpend);
  const message = lastMessage(p.buy);
  const signature = p.buy?.result?.signature ?? null;
  const txUrl = signature ? transactionUrl(p.explorer, p.network, signature) : null;
  const rowBuyBlocked =
    p.buyBlocked ??
    (state.ready ? null : 'This wallet is not ready: ' + idle.text.toLowerCase() + '.');
  const amountProblem = state.overBalance
    ? 'More than the wallet balance.'
    : state.reserveTooLow && state.reserve !== null
      ? `Leaves ${formatSol(state.reserve)} SOL; the minimum reserve is ${formatSol(p.minReserve)} SOL.`
      : null;
  return (
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
      <td>
        <AmountField
          label={p.label}
          savedText={p.amountText}
          savedUnit={p.amountUnit}
          placeholder={p.defaultAmount}
          locked={p.locked}
          problem={amountProblem}
          onSave={save}
        />
      </td>
      <td>
        <Pair what="Priority fee" buy={p.buyFee} sell={p.sellFee} />
      </td>
      <td>
        <Pair what="Slippage" buy={p.buySlip} sell={p.sellSlip} />
      </td>
      <td className="num">{p.token ?? NONE}</td>
      <td>
        {p.buy === null ? (
          <Chip tone={idle.tone}>{idle.text}</Chip>
        ) : (
          <Chip tone={stateTone(p.buy)} dot={stateTone(p.buy) === 'run'}>
            {stateLabel(p.buy)}
          </Chip>
        )}
        {message && (
          <p className="cap" title={message.title}>
            {message.text}
          </p>
        )}
      </td>
      <td className="c-tx">
        {signature && txUrl ? (
          <span className="tx">
            <a href={txUrl} target="_blank" rel="noopener noreferrer" className="mono">
              {shortAddress(signature)}
            </a>
            <small>+{seconds(p.buy?.sinceStartMs ?? 0)} after start</small>
          </span>
        ) : (
          NONE
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
          <EditWallet
            label={p.label}
            placeholders={{
              amount: p.amountNow,
              buySlip: p.buySlip,
              sellSlip: p.sellSlip,
              sellPart: p.sellPart,
            }}
            locked={p.locked}
            onSave={save}
          />
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
        </div>
      </td>
    </tr>
  );
});

export interface FleetTableProps {
  readonly wallets: readonly FleetRowData[];
  readonly lamports: ReadonlyMap<number, bigint> | null;
  /** Token balances in base units, with the decimals and the program of the shown token. */
  readonly token: {
    readonly amounts: ReadonlyMap<number, bigint>;
    readonly decimals: number;
    readonly program: 'spl-token' | 'token-2022';
  } | null;
  /** SOL buy amounts saved in the vault (`maxSpend`). */
  readonly maxSpend: ReadonlyMap<number, bigint>;
  /** Trade parameters saved in the vault (D-045). */
  readonly trade: TradeSettingsV1;
  /** Wallets in a running action of their group (BUNNDLY-71). */
  readonly locked?: ReadonlySet<number>;
  /** Wallets without an entry are selected (D-019). */
  readonly selected: Readonly<Record<number, boolean>>;
  readonly minReserve: bigint;
  readonly onTrade: RowProps['onTrade'];
  readonly onSelect: RowProps['onSelect'];
  /** Selects or clears the given wallets: the ones the filter and the search show. */
  readonly onSelectAll: (indices: readonly number[], selected: boolean) => void;
  readonly onCopy: RowProps['onCopy'];
  readonly probe?: RowProps['probe'];
  /** Progress of the current buy, or null before the first one (BUNNDLY-27). */
  readonly buy?: ReadonlyMap<number, BuyRow> | null;
  readonly explorer?: Explorer;
  /** Explorer links lead to this network's pages. */
  readonly network?: Network;
  /** Controls on the right of the filter tabs. */
  readonly tools?: ReactNode;
  /** Row action "Buy" with that wallet alone (BUNNDLY-59). */
  readonly onBuyWallet?: (index: number) => void;
  /** Why no buy can start now, for every row; null when rows may buy. */
  readonly rowBuyBlocked?: string | null;
}

/** A column header that sorts the table; `aria-sort` says how it is sorted now. */
function SortHeader({
  label,
  name,
  sortKey,
  sort,
  onSort,
}: {
  readonly label: string;
  /** Accessible name of the column when it differs from the visible label. */
  readonly name?: string;
  readonly sortKey: SortKey;
  readonly sort: Sort;
  readonly onSort: (key: SortKey) => void;
}) {
  const active = sort.key === sortKey;
  return (
    <th
      scope="col"
      aria-label={name}
      aria-sort={active ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        className={cx('th-sort', active && 'on')}
        onClick={() => {
          onSort(sortKey);
        }}
      >
        {label}
        <SortIcon />
      </button>
    </th>
  );
}

/**
 * Wallet table (SPEC 11.2, mockup v2): filter tabs with counts and a search over it, one
 * 68 px row per wallet, sortable columns. A buy's outcome stays in the row: the state, the
 * wallet's last message under it and the transaction in "Last transaction".
 */
export function FleetTable(t: FleetTableProps) {
  const ids = useId();
  const explorer = t.explorer ?? 'solscan';
  const network = t.network ?? 'mainnet';
  const [filter, setFilter] = useState<WalletFilter>('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);

  const tokenText = useMemo(() => {
    const token = t.token;
    if (token === null) return null;
    return new Map(
      [...token.amounts].map(([index, amount]) => [index, formatUnits(amount, token.decimals)]),
    );
  }, [t.token]);

  const rows = t.wallets.map((w) => {
    const balance = t.lamports?.get(w.index) ?? null;
    const own = ownAmount(t.trade, w.index, t.maxSpend.get(w.index));
    const effective = walletTrade(t.trade, w.index, t.maxSpend.get(w.index));
    const amount = plannedSpend(effective.buyAmount, balance, t.minReserve);
    const selected = t.selected[w.index] ?? true;
    const buy = t.buy?.get(w.index) ?? null;
    const filterable: FilterWallet = {
      selected,
      buy,
      reserveTooLow: rowState({
        balance,
        maxSpend: amount,
        minReserve: t.minReserve,
        active: selected,
      }).reserveTooLow,
    };
    return {
      wallet: w,
      own,
      effective,
      spend: amount,
      filterable,
      sortable: {
        index: w.index,
        balance,
        amount,
        tokens: t.token?.amounts.get(w.index) ?? null,
      },
    };
  });
  const counts = Object.fromEntries(
    WALLET_FILTERS.map((f) => [
      f.key,
      rows.filter((r) => matchesFilter(f.key, r.filterable)).length,
    ]),
  ) as Record<WalletFilter, number>;
  const shown = rows.filter(
    (r) =>
      matchesFilter(filter, r.filterable) && matchesSearch(query, r.wallet.label, r.wallet.address),
  );
  const byIndex = new Map(shown.map((r) => [r.wallet.index, r]));
  const order = sortWallets(
    shown.map((r) => r.sortable),
    sort,
  );
  const visibleRows = order.flatMap((i) => {
    const r = byIndex.get(i);
    return r ? [r] : [];
  });
  const visible = visibleRows.map((r) => r.wallet);
  const fleet = t.trade.fleet;
  const defaultAmount =
    fleet.buyAmount === null ? 'No amount' : `Default ${amountLabel(fleet.buyAmount)}`;

  const selectedCount = t.wallets.filter((w) => t.selected[w.index] ?? true).length;
  const visibleSelected = visible.filter((w) => t.selected[w.index] ?? true).length;
  const onSort = (key: SortKey): void => {
    setSort((s) => nextSort(s, key));
  };

  return (
    <div className="wallets-block">
      <div className="tabsrow">
        <div className="tabs" role="group" aria-label="Wallet filters">
          {WALLET_FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              className={cx('tab', filter === f.key && 'on')}
              aria-pressed={filter === f.key}
              onClick={() => {
                setFilter(f.key);
              }}
            >
              {f.label} <span className="tab-count">{counts[f.key]}</span>
            </button>
          ))}
        </div>
        <span className="spacer" />
        {t.tools}
      </div>
      <div className="table-bar">
        <label className="search" htmlFor={`${ids}-q`}>
          <SearchIcon />
          <span className="sr-only">Search wallets</span>
          <Input
            id={`${ids}-q`}
            type="search"
            placeholder="Search wallets…"
            spellCheck={false}
            autoComplete="off"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
            }}
          />
        </label>
        <span className="sel-count" aria-live="polite">
          {selectedCount} of {t.wallets.length} selected
        </span>
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
                  checked={
                    visibleSelected === 0
                      ? false
                      : visibleSelected === visible.length
                        ? true
                        : 'mixed'
                  }
                  disabled={visible.length === 0}
                  onChange={(checked) => {
                    t.onSelectAll(
                      visible.map((w) => w.index),
                      checked,
                    );
                  }}
                />
              </th>
              <SortHeader label="Wallet" sortKey="wallet" sort={sort} onSort={onSort} />
              <SortHeader
                label="Balance"
                name="Balance (SOL)"
                sortKey="balance"
                sort={sort}
                onSort={onSort}
              />
              <SortHeader
                label="Buy amount"
                name="Buy amount (SOL or % of balance)"
                sortKey="amount"
                sort={sort}
                onSort={onSort}
              />
              <th scope="col">Priority fee</th>
              <th scope="col">Slippage</th>
              <SortHeader
                label={
                  t.token
                    ? `Tokens (${t.token.program === 'token-2022' ? 'Token-2022' : 'SPL'})`
                    : 'Tokens'
                }
                sortKey="tokens"
                sort={sort}
                onSort={onSort}
              />
              <th scope="col">Status</th>
              <th scope="col" className="c-tx">
                Last transaction
              </th>
              <th scope="col" className="c-acts">
                <span className="sr-only">Wallet tools</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map(({ wallet: w, own, effective, spend }) => (
              <FleetRow
                key={w.index}
                index={w.index}
                label={w.label}
                address={w.address}
                balance={t.lamports?.get(w.index) ?? null}
                token={tokenText?.get(w.index) ?? null}
                amountText={amountText(own)}
                amountUnit={own?.kind === 'percent' ? '%' : 'SOL'}
                defaultAmount={defaultAmount}
                spend={spend}
                amountNow={amountLabel(effective.buyAmount)}
                buySlip={slippageLabel(effective.buySlippageBps)}
                sellSlip={slippageLabel(effective.sellSlippageBps)}
                buyFee={feeLabel(effective.buyPriorityFeeLamports)}
                sellFee={feeLabel(effective.sellPriorityFeeLamports)}
                sellPart={`${String(effective.sellPercent)} %`}
                locked={t.locked?.has(w.index) ?? false}
                selected={t.selected[w.index] ?? true}
                minReserve={t.minReserve}
                onTrade={t.onTrade}
                onSelect={t.onSelect}
                onCopy={t.onCopy}
                probe={t.probe}
                buy={t.buy?.get(w.index) ?? null}
                explorer={explorer}
                network={network}
                onBuy={t.onBuyWallet}
                buyBlocked={t.rowBuyBlocked ?? null}
              />
            ))}
            {visible.length === 0 && (
              <tr className="empty">
                <td colSpan={COLUMNS}>
                  {t.wallets.length === 0 ? 'No wallets yet.' : 'No wallet matches the filter.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
