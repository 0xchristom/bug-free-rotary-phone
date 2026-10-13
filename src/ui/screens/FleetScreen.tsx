import { useCallback, useEffect, useId, useMemo, useState, type SyntheticEvent } from 'react';
import { toUserMessage } from '../../core/errors.ts';
import { NO_BUY_ROUTE_MESSAGE, buyRouteOf } from '../../core/network.ts';
import { effectiveJupiterPlan } from '../../core/settings.ts';
import {
  saveKeystoreFile,
  supportsDirectoryPicker,
  type SaveResult,
  type StorageEnv,
} from '../../storage/keystore-file.ts';
import type { VaultInfo } from '../../worker/protocol.ts';
import { BuyPanel } from '../BuyPanel.tsx';
import { ExportDialog } from '../ExportDialog.tsx';
import { FleetBulk, FleetSummaryBar } from '../FleetBulk.tsx';
import { shareOf, summarize } from '../fleet-math.ts';
import { FleetTable } from '../FleetTable.tsx';
import type { OperationsLog } from '../operations-log.ts';
import { OperationsLogPanel } from '../OperationsLogPanel.tsx';
import { SettingsResetNotice } from '../SettingsResetNotice.tsx';
import { formatSol, formatUnits, parseSolAmount } from '../sol.ts';
import { useBalances } from '../use-balances.ts';
import { EMPTY_BUY, type BuyView } from '../use-buy.ts';
import { useVault } from '../vault-state.ts';
import { WATCH_FROZEN } from '../watch-labels.ts';

const MAX_WALLETS = 100;

type AddPhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'adding' }
  /** Wallets added or table changes saved in the vault; the file is not written yet. */
  | {
      readonly kind: 'unsaved';
      readonly fileText: string;
      readonly fleetName: string;
      /** What changed, shown in the notice. */
      readonly note: string;
      readonly savedNote: string;
      readonly saving: boolean;
    }
  | { readonly kind: 'saved'; readonly result: SaveResult; readonly savedNote: string }
  | { readonly kind: 'savingTable' };

export interface FleetScreenProps {
  readonly info: VaultInfo;
  readonly storage: StorageEnv;
  /** True while table edits or a new file are not saved yet. */
  readonly onUnsavedChange: (unsaved: boolean) => void;
  /** How often SOL balances are re-read while the tab is visible. */
  readonly balanceRefreshMs?: number;
  /** Test hook for the row render counter (see FleetTable). */
  readonly rowProbe?: (index: number) => void;
  /** Session log of buys (BUNNDLY-25); the panel is hidden without it. */
  readonly operationsLog?: OperationsLog;
  /** Progress of the current or last buy (BUNNDLY-27), kept by the app across screens. */
  readonly buyView?: BuyView;
  /** Decimals of every mint the worker read this session (the bought one may differ from the field). */
  readonly mintDecimals?: ReadonlyMap<string, number>;
  readonly onMintDecimals?: (mint: string, decimals: number) => void;
}

type Drafts = Readonly<Record<number, string>>;
type ActiveDrafts = Readonly<Record<number, boolean>>;

function maxSpendDrafts(info: VaultInfo): Drafts {
  return Object.fromEntries(info.settings.maxSpend.map((m) => [m.index, formatSol(m.lamports)]));
}

function activeDrafts(info: VaultInfo): ActiveDrafts {
  return Object.fromEntries(info.settings.active.map((a) => [a.index, a.active]));
}

function confirmOverwrite(fileName: string): boolean {
  return window.confirm(
    `The file “${fileName}” already exists in the chosen folder. Replace it with the updated fleet file?`,
  );
}

/**
 * Unlocked fleet (SPEC 3.2): the fleet table with balances, max spend, reserve, token
 * balance and the active flag; table changes are saved through the vault (saveSettings)
 * and then written to the file on click (D-017). Also "Add wallets" (BUNNDLY-10).
 */
export function FleetScreen({
  info,
  storage,
  onUnsavedChange,
  balanceRefreshMs,
  rowProbe,
  operationsLog,
  buyView = EMPTY_BUY,
  mintDecimals,
  onMintDecimals,
}: FleetScreenProps) {
  const { client, status, refresh } = useVault();
  const watchArmed = status?.watch?.armed ?? false;
  const [mintText, setMintText] = useState('');
  const [mint, setMint] = useState<string | null>(null);
  const [mintError, setMintError] = useState<string | null>(null);
  // A wrong mint: show the message at the field and go on refreshing SOL without it.
  const onBadMint = useCallback((message: string) => {
    setMint(null);
    setMintError(message);
  }, []);
  const balances = useBalances(
    client,
    balanceRefreshMs,
    mint,
    onBadMint,
    info.settings.global.network,
  );
  const [maxSpendText, setMaxSpendText] = useState<Drafts>(() => maxSpendDrafts(info));
  const [active, setActive] = useState<ActiveDrafts>(() => activeDrafts(info));
  const ids = useId();
  const [qrFor, setQrFor] = useState<number | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [copied, setCopied] = useState<number | null>(null);
  const [addCount, setAddCount] = useState('1');
  const [phase, setPhase] = useState<AddPhase>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);

  // Edits compared with what the vault holds, by value ("0.5" equals "0,5"); an empty
  // field means "no max spend".
  const savedMaxSpend = useMemo(
    () => new Map(info.settings.maxSpend.map((m) => [m.index, m.lamports])),
    [info],
  );
  const savedActive = useMemo(() => activeDrafts(info), [info]);
  const draftLamports = (index: number): bigint | null | 'invalid' => {
    const text = (maxSpendText[index] ?? '').trim();
    if (text === '') return null;
    const parsed = parseSolAmount(text);
    return parsed.ok ? parsed.lamports : 'invalid';
  };
  const tableDirty = info.wallets.some(
    (w) =>
      draftLamports(w.index) !== (savedMaxSpend.get(w.index) ?? null) ||
      (active[w.index] ?? true) !== (savedActive[w.index] ?? true),
  );
  const tableInvalid = info.wallets.some((w) => {
    const text = (maxSpendText[w.index] ?? '').trim();
    return text !== '' && !parseSolAmount(text).ok;
  });

  const unsaved = phase.kind === 'unsaved' || tableDirty;
  useEffect(() => {
    onUnsavedChange(unsaved);
    return () => {
      onUnsavedChange(false); // unmounted (e.g. after a lock): nothing left to protect
    };
  }, [unsaved, onUnsavedChange]);

  const room = MAX_WALLETS - info.wallets.length;
  const count = Number(addCount);
  const countValid =
    addCount.trim() !== '' && Number.isInteger(count) && count >= 1 && count <= room;

  const copy = async (index: number, address: string): Promise<void> => {
    setError(null);
    try {
      await navigator.clipboard.writeText(address);
      setCopied(index);
    } catch {
      setCopied(null);
      setError('The address could not be copied. Select it and copy it by hand.');
    }
  };

  const onMaxSpend = useCallback((index: number, text: string) => {
    setMaxSpendText((d) => ({ ...d, [index]: text }));
  }, []);
  const onActive = useCallback((index: number, value: boolean) => {
    setActive((d) => ({ ...d, [index]: value }));
  }, []);
  const onCopy = useCallback((index: number, address: string) => {
    void copy(index, address);
  }, []);
  const onQr = useCallback((index: number) => {
    setQrFor((current) => (current === index ? null : index));
  }, []);

  const tokenAmounts = useMemo(() => {
    const token = balances.token;
    if (!token) return null;
    return new Map(
      [...token.amounts].map(([index, amount]) => [index, formatUnits(amount, token.decimals)]),
    );
  }, [balances.token]);

  // Bulk actions change only the drafts; saving stays a separate, explicit step.
  const setAllAmount = (lamports: bigint): void => {
    setMaxSpendText(Object.fromEntries(info.wallets.map((w) => [w.index, formatSol(lamports)])));
  };
  const setAllPercent = (basisPoints: number): void => {
    setMaxSpendText((d) => {
      const next: Record<number, string> = { ...d };
      for (const w of info.wallets) {
        const balance = balances.lamports?.get(w.index);
        if (balance !== undefined) next[w.index] = formatSol(shareOf(balance, basisPoints));
      }
      return next;
    });
  };
  const setAllActive = (value: boolean): void => {
    setActive(Object.fromEntries(info.wallets.map((w) => [w.index, value])));
  };
  const unknownBalances = info.wallets.filter((w) => !balances.lamports?.has(w.index)).length;

  const summary = summarize(
    info.wallets.map((w) => {
      const lamports = draftLamports(w.index);
      return {
        balance: balances.lamports?.get(w.index) ?? null,
        maxSpend: typeof lamports === 'bigint' ? lamports : null,
        minReserve: info.settings.global.minReserveLamports,
        active: active[w.index] ?? true,
        token: balances.token?.amounts.get(w.index) ?? null,
      };
    }),
  );

  // The worker checked this mint (its token balance is on screen): only then can a buy start.
  const checkedMint = balances.token !== null && balances.token.mint === mint ? mint : null;
  const { global } = info.settings;
  const hasRpc = info.apiKeys.helius || info.apiKeys.heliusRpcUrl;
  const buyBlocked =
    buyRouteOf(global.network) === null
      ? NO_BUY_ROUTE_MESSAGE
      : tableDirty
        ? 'Save the table changes first: a buy uses the settings saved in the vault.'
        : !global.dryRun && !hasRpc
          ? 'Live mode needs a Helius key (Settings).'
          : null;
  const token = balances.token;
  useEffect(() => {
    if (token) onMintDecimals?.(token.mint, token.decimals);
  }, [token, onMintDecimals]);
  // Decimals of the mint the buy used, not of whatever the mint field shows now.
  const buyDecimals =
    buyView.run === null
      ? null
      : (mintDecimals?.get(buyView.run.mint) ??
        (token?.mint === buyView.run.mint ? token.decimals : null));

  /** DRY-RUN or live mode: saved in the vault, then the fleet file waits to be saved. */
  const setDryRun = async (dryRun: boolean): Promise<void> => {
    const result = await client.request({
      type: 'saveSettings',
      settings: {
        maxSpend: info.settings.maxSpend,
        active: info.settings.active,
        global: { ...global, dryRun },
      },
    });
    setPhase({
      kind: 'unsaved',
      fileText: result.fileText,
      fleetName: result.info.fleetName,
      note: dryRun ? 'DRY-RUN mode is saved in the vault.' : 'Live mode is saved in the vault.',
      savedNote: 'with the new DRY-RUN / live mode setting',
      saving: false,
    });
    await refresh();
  };

  /** One-shot or continuous (mode B): saved like the DRY-RUN switch. */
  const setWatchMode = async (mode: typeof global.mode): Promise<void> => {
    const result = await client.request({
      type: 'saveSettings',
      settings: {
        maxSpend: info.settings.maxSpend,
        active: info.settings.active,
        global: { ...global, mode },
      },
    });
    setPhase({
      kind: 'unsaved',
      fileText: result.fileText,
      fleetName: result.info.fleetName,
      note:
        mode === 'continuous'
          ? 'Continuous mode is saved in the vault.'
          : 'One-shot mode is saved in the vault.',
      savedNote: 'with the new watcher mode',
      saving: false,
    });
    await refresh();
  };
  const fleetAddresses = useMemo(() => info.wallets.map((w) => w.address), [info.wallets]);

  const saveTable = async (): Promise<void> => {
    if (!tableDirty || tableInvalid || phase.kind === 'unsaved' || phase.kind === 'adding') return;
    const maxSpend = info.wallets.flatMap((w) => {
      const parsed = parseSolAmount(maxSpendText[w.index] ?? '');
      return parsed.ok ? [{ index: w.index, lamports: parsed.lamports }] : [];
    });
    // Wallets without an entry are active (D-019): store only the inactive ones.
    const inactive = info.wallets
      .filter((w) => active[w.index] === false)
      .map((w) => ({ index: w.index, active: false }));
    setError(null);
    setPhase({ kind: 'savingTable' });
    try {
      const result = await client.request({
        type: 'saveSettings',
        settings: { maxSpend, active: inactive, global: info.settings.global },
      });
      setPhase({
        kind: 'unsaved',
        fileText: result.fileText,
        fleetName: result.info.fleetName,
        note: 'The table changes (max spend, active wallets) are saved in the vault.',
        savedNote: 'with the new fleet settings',
        saving: false,
      });
      await refresh();
    } catch (e) {
      setError(toUserMessage(e));
      setPhase({ kind: 'idle' });
    }
  };

  const showToken = (event: SyntheticEvent): void => {
    event.preventDefault();
    const text = mintText.trim();
    setMintError(null);
    setMint(text === '' ? null : text);
  };

  const add = async (event: SyntheticEvent): Promise<void> => {
    event.preventDefault();
    if (!countValid || phase.kind === 'adding' || phase.kind === 'unsaved' || tableDirty) return;
    setError(null);
    setPhase({ kind: 'adding' });
    try {
      const result = await client.request({ type: 'addWallets', count });
      setPhase({
        kind: 'unsaved',
        fileText: result.fileText,
        fleetName: result.info.fleetName,
        note: `New wallets: ${String(count)}. The old file opens the fleet without the new wallets.`,
        savedNote: 'with the new wallets',
        saving: false,
      });
      setAddCount('1');
      await refresh();
    } catch (e) {
      setError(toUserMessage(e));
      setPhase({ kind: 'idle' });
    }
  };

  const save = async (current: Extract<AddPhase, { kind: 'unsaved' }>): Promise<void> => {
    setError(null);
    setPhase({ ...current, saving: true });
    try {
      const result = await saveKeystoreFile(current.fileText, current.fleetName, storage, {
        confirmOverwrite,
      });
      setPhase({ kind: 'saved', result, savedNote: current.savedNote });
    } catch (e) {
      setError(toUserMessage(e));
      setPhase({ ...current, saving: false });
    }
  };

  return (
    <section className="screen" aria-labelledby={`${ids}-title`}>
      <h2 id={`${ids}-title`}>Fleet</h2>
      <p>
        Wallets in the fleet: <strong>{info.wallets.length}</strong>
      </p>
      <div className="inline balances-bar">
        <span className="muted" aria-live="polite">
          {balances.fetchedAt
            ? `Balances as of ${new Date(balances.fetchedAt).toLocaleTimeString('en-GB')}`
            : 'Balances: loading…'}
        </span>
        <button type="button" onClick={balances.refresh}>
          Refresh balances
        </button>
      </div>
      {balances.source === 'fallback' && (
        <p className="notice warning">
          Helius is not responding. The balances come from the public Solana RPC and may be delayed.
        </p>
      )}
      {balances.error && (
        <p className="notice error" role="alert">
          {balances.error}
        </p>
      )}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}

      <SettingsResetNotice fields={info.settings.resetFields} />

      <form className="token-bar" onSubmit={showToken}>
        <label htmlFor={`${ids}-mint`}>Token address (mint)</label>
        <div className="inline">
          <input
            id={`${ids}-mint`}
            type="text"
            value={mintText}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={mintError !== null}
            aria-describedby={`${ids}-mint-help`}
            onChange={(e) => {
              setMintText(e.target.value);
            }}
          />
          <button type="submit">Show token balance</button>
        </div>
        {mintError ? (
          <p className="field-error" id={`${ids}-mint-help`} role="alert">
            {mintError}
          </p>
        ) : (
          <p className="hint" id={`${ids}-mint-help`}>
            Balance preview only; the address is not saved in the fleet file.
          </p>
        )}
      </form>

      <BuyPanel
        view={buyView}
        mint={checkedMint}
        readyCount={summary.readyCount}
        toSpend={summary.toSpendLamports}
        dryRun={global.dryRun}
        blocked={buyBlocked}
        plan={effectiveJupiterPlan(global, info.apiKeys.jupiter)}
        onDryRun={setDryRun}
        fleetAddresses={fleetAddresses}
        apiKeys={info.apiKeys}
        watchMode={global.mode}
        onWatchMode={setWatchMode}
      >
        {operationsLog && (
          <OperationsLogPanel log={operationsLog} storage={storage} decimals={buyDecimals} />
        )}
      </BuyPanel>

      <FleetSummaryBar
        summary={summary}
        walletCount={info.wallets.length}
        tokenDecimals={balances.token?.decimals ?? null}
      />
      <FleetBulk
        onAmount={setAllAmount}
        onPercent={setAllPercent}
        onAllActive={setAllActive}
        unknownBalances={unknownBalances}
      />

      <FleetTable
        wallets={info.wallets}
        lamports={balances.lamports}
        tokenAmounts={tokenAmounts}
        tokenLabel={
          balances.token
            ? `Token (${balances.token.program === 'token-2022' ? 'Token-2022' : 'SPL'})`
            : null
        }
        maxSpendText={maxSpendText}
        active={active}
        minReserve={info.settings.global.minReserveLamports}
        qrFor={qrFor}
        copied={copied}
        onMaxSpend={onMaxSpend}
        onActive={onActive}
        onCopy={onCopy}
        onQr={onQr}
        probe={rowProbe}
        buy={buyView.run === null ? null : buyView.rows}
        buyDecimals={buyDecimals}
        explorer={global.explorer}
        network={global.network}
      />
      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={
            watchArmed ||
            !tableDirty ||
            tableInvalid ||
            (phase.kind !== 'idle' && phase.kind !== 'saved')
          }
          onClick={() => void saveTable()}
        >
          {phase.kind === 'savingTable' ? 'Saving…' : 'Save table changes'}
        </button>
        {watchArmed ? (
          <span className="muted">{WATCH_FROZEN}</span>
        ) : (
          tableDirty && <span className="muted">You have unsaved table changes.</span>
        )}
      </div>

      {phase.kind === 'unsaved' && (
        <div className="notice warning" role="status">
          <p>{phase.note} The updated fleet file is not saved yet.</p>
          {!supportsDirectoryPicker(storage) && (
            <p className="muted">
              Your browser will download the file. Then check the “Downloads” folder.
            </p>
          )}
          <div className="actions">
            <button
              type="button"
              className="primary"
              disabled={phase.saving}
              onClick={() => void save(phase)}
            >
              {phase.saving ? 'Saving…' : 'Save the updated fleet file'}
            </button>
          </div>
        </div>
      )}
      {phase.kind === 'saved' && (
        <p className="notice" role="status">
          Saved {phase.result.fileName} {phase.savedNote}.
        </p>
      )}

      <h3>Add wallets</h3>
      {phase.kind === 'unsaved' || tableDirty ? (
        <p className="muted">
          Save the table changes and the updated fleet file first, then add wallets.
        </p>
      ) : room === 0 ? (
        <p className="muted">The fleet already has the maximum of {MAX_WALLETS} wallets.</p>
      ) : (
        <form className="form" onSubmit={(e) => void add(e)} noValidate>
          <label htmlFor={`${ids}-add`}>Number of new wallets</label>
          <input
            id={`${ids}-add`}
            type="number"
            min={1}
            max={room}
            step={1}
            value={addCount}
            onChange={(e) => {
              setAddCount(e.target.value);
            }}
            aria-invalid={!countValid}
          />
          {!countValid && (
            <p className="field-error">
              You can add 1 to {room} wallets (at most {MAX_WALLETS} in total).
            </p>
          )}
          <div className="actions">
            <button
              type="submit"
              className="primary"
              disabled={watchArmed || !countValid || phase.kind === 'adding'}
            >
              {phase.kind === 'adding' ? 'Adding…' : 'Add wallets'}
            </button>
            {watchArmed && <span className="muted">{WATCH_FROZEN}</span>}
          </div>
        </form>
      )}

      <h3>Backup</h3>
      <p className="muted">
        The only way to get a copy of the recovery phrase and the private keys is a plain export
        after typing the password again.
      </p>
      {exportOpen ? (
        <ExportDialog
          storage={storage}
          onClose={() => {
            setExportOpen(false);
          }}
        />
      ) : (
        <div className="actions">
          <button
            type="button"
            onClick={() => {
              setExportOpen(true);
            }}
          >
            Plain export (recovery phrase and keys)
          </button>
        </div>
      )}
    </section>
  );
}
