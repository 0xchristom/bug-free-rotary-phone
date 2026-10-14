import { useId, useRef, useState, type SyntheticEvent } from 'react';
import {
  DEFAULT,
  LOCKED_HINT,
  parseAmount,
  parseSellPercent,
  parseSlippage,
  type Parsed,
  type WalletPatch,
} from './trade-edit.ts';
import type { BuyAmount } from '../core/trade.ts';
import {
  Button,
  EditIcon,
  IconButton,
  Input,
  NumberInput,
  Popover,
  SlidersIcon,
  SolIcon,
} from './kit/index.ts';

function sameAmount(
  value: BuyAmount | typeof DEFAULT,
  saved: ReturnType<typeof parseAmount>,
): boolean {
  if (!saved.ok) return false;
  if (value === DEFAULT || saved.value === DEFAULT) return value === saved.value;
  return value.kind === 'lamports'
    ? saved.value.kind === 'lamports' && saved.value.lamports === value.lamports
    : saved.value.kind === 'percent' && saved.value.percent === value.percent;
}

function amountKey(value: BuyAmount | typeof DEFAULT): string {
  if (value === DEFAULT) return DEFAULT;
  return value.kind === 'lamports'
    ? `${String(value.lamports)} lamports`
    : `${String(value.percent)} %`;
}

/** Saves a change; resolves to an error message for the field, or null when it is saved. */
export type SaveTrade = (patch: WalletPatch) => Promise<string | null>;

export type AmountUnit = 'SOL' | '%';

/**
 * The buy amount of one wallet, typed straight into the row (BUNNDLY-71). Saved on Enter or
 * when the field is left; a refused save puts the saved value back and says why.
 */
export function AmountField({
  label,
  savedText,
  savedUnit,
  placeholder,
  locked,
  problem,
  onSave,
}: {
  readonly label: string;
  /** The wallet's own amount as text; empty when it takes the fleet default. */
  readonly savedText: string;
  readonly savedUnit: AmountUnit;
  readonly placeholder: string;
  /** The wallet is in a running action of its group. */
  readonly locked: boolean;
  /** A warning about the saved amount (reserve, balance), shown when nothing else is. */
  readonly problem: string | null;
  readonly onSave: SaveTrade;
}) {
  const [text, setText] = useState(savedText);
  const [unit, setUnit] = useState<AmountUnit>(savedUnit);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  /** The amount last sent and the saved value it was sent from. */
  const sent = useRef<{ readonly key: string; readonly base: string } | null>(null);
  // A new saved value (this field, "Edit selected", Settings) replaces what the field
  // shows; adjusted while rendering, as React advises for state derived from props.
  const savedKey = `${savedUnit}|${savedText}`;
  const [shownKey, setShownKey] = useState(savedKey);
  if (shownKey !== savedKey) {
    setShownKey(savedKey);
    setText(savedText);
    setUnit(savedUnit);
  }

  const commit = async (nextText: string, nextUnit: AmountUnit): Promise<void> => {
    const parsed = parseAmount(nextText, nextUnit);
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    setError(null);
    // The saved value again ("0,5" for 0.5 SOL, or nothing typed): nothing to save.
    if (sameAmount(parsed.value, parseAmount(savedText, savedUnit))) return;
    // Already sent from this saved value (Enter, then the field left before the answer is
    // shown): one change, one save (BUNNDLY-76).
    const key = amountKey(parsed.value);
    if (sent.current?.key === key && sent.current.base === savedKey) return;
    sent.current = { key, base: savedKey };
    const refused = await onSave({ amount: parsed.value });
    if (refused !== null) {
      sent.current = null;
      setText(savedText);
      setUnit(savedUnit);
      setError(refused);
    }
  };

  const message = locked ? LOCKED_HINT : (error ?? problem);
  return (
    <div className="amount-field">
      <span className="amount-row amt">
        <SolIcon />
        <NumberInput
          unit=""
          className="amount-input"
          ref={field}
          aria-label={`Buy amount ${label}`}
          value={text}
          placeholder={placeholder}
          disabled={locked}
          invalid={error !== null && !locked}
          onChange={(e) => {
            setText(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void commit(text, unit);
            if (e.key === 'Escape') {
              setText(savedText);
              setUnit(savedUnit);
              setError(null);
            }
          }}
          onBlur={(e) => {
            // The field and its unit button are one control: leaving both saves.
            if (e.relatedTarget !== toggle.current) void commit(text, unit);
          }}
        />
        <button
          ref={toggle}
          type="button"
          className="unit-toggle"
          disabled={locked}
          onBlur={(e) => {
            if (e.relatedTarget !== field.current) void commit(text, unit);
          }}
          aria-label={`Unit of the buy amount ${label}: ${unit === 'SOL' ? 'SOL' : 'percent of balance'}. Switch`}
          onClick={() => {
            const next = unit === 'SOL' ? '%' : 'SOL';
            setUnit(next);
            if (text.trim() !== '') void commit(text, next);
          }}
        >
          {unit}
        </button>
      </span>
      {message && (
        <p className={locked ? 'cap' : 'field-error'} role={error && !locked ? 'alert' : undefined}>
          {message}
        </p>
      )}
    </div>
  );
}

/** What the fields show while empty: the values that stay when they are left empty. */
export interface TradePlaceholders {
  readonly amount: string;
  readonly buySlip: string;
  readonly sellSlip: string;
  readonly sellPart: string;
}

const FEE_TITLE = 'Auto: on the Jupiter route the priority fee is not sent (D-045).';

/** An empty field changes nothing; "Default" gives the wallet the fleet value again. */
function fieldValue<T>(text: string, parse: (t: string) => Parsed<T>): Parsed<T> | null {
  const t = text.trim();
  if (t === '') return null;
  if (t.toLowerCase() === DEFAULT) return { ok: true, value: DEFAULT as T };
  return parse(t);
}

/**
 * "Trade settings" (the mockup's Edit popover): one change for one wallet or for every
 * selected wallet, saved in one request. An empty field keeps each wallet's value.
 */
function TradeForm({
  title,
  placeholders,
  locked,
  onSave,
  onClose,
}: {
  readonly title: string;
  readonly placeholders: TradePlaceholders;
  readonly locked: boolean;
  readonly onSave: SaveTrade;
  readonly onClose: () => void;
}) {
  const ids = useId();
  const [amount, setAmount] = useState('');
  const [unit, setUnit] = useState<AmountUnit>('SOL');
  const [buySlip, setBuySlip] = useState('');
  const [sellSlip, setSellSlip] = useState('');
  const [sellPart, setSellPart] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (event: SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (locked || saving) return;
    const patch: { -readonly [K in keyof WalletPatch]: WalletPatch[K] } = {};
    const a = fieldValue(amount, (t) => parseAmount(t, unit));
    const b = fieldValue(buySlip, parseSlippage);
    const s = fieldValue(sellSlip, parseSlippage);
    const p = fieldValue(sellPart, parseSellPercent);
    for (const parsed of [a, b, s, p]) {
      if (parsed !== null && !parsed.ok) {
        setError(parsed.message);
        return;
      }
    }
    if (a?.ok) patch.amount = a.value;
    if (b?.ok) patch.buySlippageBps = b.value;
    if (s?.ok) patch.sellSlippageBps = s.value;
    if (p?.ok) patch.sellPercent = p.value;
    if (Object.keys(patch).length === 0) {
      setError('Fill in at least one value.');
      return;
    }
    setSaving(true);
    const refused = await onSave(patch);
    setSaving(false);
    if (refused === null) onClose();
    else setError(refused);
  };

  const text = (
    key: string,
    name: string,
    value: string,
    set: (v: string) => void,
    placeholder: string,
  ) => (
    <div className="tf">
      <label htmlFor={`${ids}-${key}`}>{name}</label>
      <Input
        id={`${ids}-${key}`}
        inputMode="decimal"
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        disabled={locked}
        onChange={(e) => {
          set(e.target.value);
        }}
      />
    </div>
  );

  return (
    <form className="trade-form" onSubmit={(e) => void submit(e)} noValidate>
      <h3>{title}</h3>
      <div className="tf">
        <label htmlFor={`${ids}-amount`}>
          Buy amount ({unit === 'SOL' ? 'SOL' : '% of balance'})
        </label>
        <span className="amount-row">
          <Input
            id={`${ids}-amount`}
            inputMode="decimal"
            autoComplete="off"
            value={amount}
            placeholder={placeholders.amount}
            disabled={locked}
            onChange={(e) => {
              setAmount(e.target.value);
            }}
          />
          <button
            type="button"
            className="unit-toggle"
            disabled={locked}
            aria-label={`Unit of the buy amount: ${unit === 'SOL' ? 'SOL' : 'percent of balance'}. Switch`}
            onClick={() => {
              setUnit((u) => (u === 'SOL' ? '%' : 'SOL'));
            }}
          >
            {unit}
          </button>
        </span>
      </div>
      <div className="grid2">
        {text('buySlip', 'Slippage, buy', buySlip, setBuySlip, placeholders.buySlip)}
        {text('sellSlip', 'Slippage, sell', sellSlip, setSellSlip, placeholders.sellSlip)}
        <div className="tf">
          <label htmlFor={`${ids}-buyFee`}>Priority fee, buy</label>
          <Input id={`${ids}-buyFee`} value="" placeholder="Auto" title={FEE_TITLE} disabled />
        </div>
        <div className="tf">
          <label htmlFor={`${ids}-sellFee`}>Priority fee, sell</label>
          <Input id={`${ids}-sellFee`} value="" placeholder="Auto" title={FEE_TITLE} disabled />
        </div>
      </div>
      {text('sellPart', 'Sell part (% of tokens)', sellPart, setSellPart, placeholders.sellPart)}
      <p>
        An empty field keeps each wallet’s current value. Type Auto or a percentage for slippage, or
        Default for the fleet value. The priority fee is Auto on the Jupiter route.
      </p>
      {locked && <p className="cap">{LOCKED_HINT}</p>}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="actions end">
        <Button size="sm" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" size="sm" variant="primary" disabled={locked} loading={saving}>
          Apply
        </Button>
      </div>
    </form>
  );
}

/** The row's edit button: trade settings of one wallet. */
export function EditWallet({
  label,
  placeholders,
  locked,
  onSave,
}: {
  readonly label: string;
  readonly placeholders: TradePlaceholders;
  /** The wallet is in a running action of its group. */
  readonly locked: boolean;
  readonly onSave: SaveTrade;
}) {
  const ids = useId();
  const [open, setOpen] = useState(false);
  const close = (): void => {
    setOpen(false);
    document.getElementById(`${ids}-open`)?.focus();
  };
  return (
    <Popover
      open={open}
      onClose={() => {
        setOpen(false);
      }}
      label={`Trade settings of ${label}`}
      trigger={
        <IconButton
          id={`${ids}-open`}
          size="sm"
          label={`Trade settings ${label}`}
          icon={<EditIcon />}
          aria-expanded={open}
          onClick={() => {
            setOpen((o) => !o);
          }}
        />
      }
    >
      <TradeForm
        title={`Trade settings · ${label}`}
        placeholders={placeholders}
        locked={locked}
        onSave={onSave}
        onClose={close}
      />
    </Popover>
  );
}

/** "Edit selected" in the toolbar: one change for every selected wallet. */
export function EditSelected({
  count,
  onSave,
}: {
  /** Selected wallets the change applies to. */
  readonly count: number;
  readonly onSave: SaveTrade;
}) {
  const ids = useId();
  const [open, setOpen] = useState(false);
  const close = (): void => {
    setOpen(false);
    document.getElementById(`${ids}-open`)?.focus();
  };
  return (
    <Popover
      open={open && count > 0}
      onClose={() => {
        setOpen(false);
      }}
      label="Trade settings of the selected wallets"
      trigger={
        <Button
          id={`${ids}-open`}
          size="sm"
          icon={<SlidersIcon />}
          aria-expanded={open && count > 0}
          disabled={count === 0}
          title={count === 0 ? 'Select wallets first.' : undefined}
          onClick={() => {
            setOpen((o) => !o);
          }}
        >
          Edit selected
        </Button>
      }
    >
      <TradeForm
        title={`Trade settings · ${String(count)} selected`}
        placeholders={{ amount: '0.10', buySlip: 'Auto', sellSlip: 'Auto', sellPart: '100' }}
        locked={false}
        onSave={onSave}
        onClose={close}
      />
    </Popover>
  );
}
