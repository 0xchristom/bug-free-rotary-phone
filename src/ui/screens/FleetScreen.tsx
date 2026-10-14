import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type SyntheticEvent,
} from 'react';
import { isAppError, toUserMessage } from '../../core/errors.ts';
import type { FleetSettingsV1 } from '../../core/keystore/format.ts';
import { walletTrade } from '../../core/trade.ts';
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
import { CreateWallets } from '../CreateWallets.tsx';
import { ExportDialog } from '../ExportDialog.tsx';
import { FleetSummaryBar } from '../FleetSummaryBar.tsx';
import { summarize } from '../fleet-math.ts';
import { FleetTable } from '../FleetTable.tsx';
import type { OperationsLog } from '../operations-log.ts';
import { OperationsLogPanel } from '../OperationsLogPanel.tsx';
import { SettingsResetNotice } from '../SettingsResetNotice.tsx';
import { LOCKED_HINT, applyWalletPatch, plannedSpend, type WalletPatch } from '../trade-edit.ts';
import { useBalances } from '../use-balances.ts';
import { EMPTY_BUY, type BuyView } from '../use-buy.ts';
import { useVault } from '../vault-state.ts';
import { WATCH_FROZEN } from '../watch-labels.ts';
import { EditSelected } from '../WalletTradeFields.tsx';
import { Button, Input, useToast } from '../kit/index.ts';

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

type ActiveDrafts = Readonly<Record<number, boolean>>;

function activeDrafts(info: VaultInfo): ActiveDrafts {
  return Object.fromEntries(info.settings.active.map((a) => [a.index, a.active]));
}

function confirmOverwrite(fileName: string): boolean {
  return window.confirm(
    `The file “${fileName}” already exists in the chosen folder. Replace it with the updated fleet file?`,
  );
}

/**
 * Unlocked fleet (SPEC 3.2, 11.2): the wallet table with balances, max spend, token balance
 * and the selection; table changes are saved through the vault (saveSettings) and then
 * written to the file on click (D-017). Also "Create wallets" (SPEC 11.1).
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
  const [active, setActive] = useState<ActiveDrafts>(() => activeDrafts(info));
  const ids = useId();
  const [exportOpen, setExportOpen] = useState(false);
  const toast = useToast();
  const [phase, setPhase] = useState<AddPhase>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);

  // Trade parameters are saved in the vault as soon as they are entered (BUNNDLY-71); only
  // the selection waits for "Save table changes".
  const savedMaxSpend = useMemo(
    () => new Map(info.settings.maxSpend.map((m) => [m.index, m.lamports])),
    [info],
  );
  const savedActive = useMemo(() => activeDrafts(info), [info]);
  const tableDirty = info.wallets.some(
    (w) => (active[w.index] ?? true) !== (savedActive[w.index] ?? true),
  );

  const unsaved = phase.kind === 'unsaved' || tableDirty;
  useEffect(() => {
    onUnsavedChange(unsaved);
    return () => {
      onUnsavedChange(false); // unmounted (e.g. after a lock): nothing left to protect
    };
  }, [unsaved, onUnsavedChange]);

  const room = MAX_WALLETS - info.wallets.length;

  // Saves run one after another, each on top of the settings the previous one left, so two
  // quick edits never overwrite each other.
  const latest = useRef<FleetSettingsV1>(info.settings);
  useEffect(() => {
    latest.current = info.settings;
  }, [info.settings]);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const saveTrade = useCallback(
    (indices: readonly number[], patch: WalletPatch): Promise<string | null> => {
      const run = async (): Promise<string | null> => {
        const current = latest.current;
        const next = applyWalletPatch(current.maxSpend, current.trade, indices, patch);
        try {
          const result = await client.request({
            type: 'saveSettings',
            settings: {
              maxSpend: next.maxSpend,
              active: current.active,
              global: current.global,
              trade: next.trade,
            },
          });
          latest.current = result.info.settings;
          setPhase({
            kind: 'unsaved',
            fileText: result.fileText,
            fleetName: result.info.fleetName,
            note: 'The trade settings are saved in the vault.',
            savedNote: 'with the new trade settings',
            saving: false,
          });
          await refresh();
          return null;
        } catch (e) {
          // The worker refuses a wallet of a running action (D-045, D-046).
          if (isAppError(e) && e.code === 'WALLET_IN_RUN') return LOCKED_HINT;
          return toUserMessage(e);
        }
      };
      const result = queue.current.then(run, run);
      queue.current = result;
      return result;
    },
    [client, refresh],
  );
  const onTrade = useCallback(
    (index: number, patch: WalletPatch) => saveTrade([index], patch),
    [saveTrade],
  );
  const onSelect = useCallback((index: number, value: boolean) => {
    setActive((d) => ({ ...d, [index]: value }));
  }, []);
  const onSelectAll = useCallback((indices: readonly number[], value: boolean) => {
    setActive((d) => ({ ...d, ...Object.fromEntries(indices.map((i) => [i, value])) }));
  }, []);
  // The address is the one the vault verified on unlock (D-018), never a typed one.
  const onCopy = useCallback(
    (_index: number, address: string) => {
      setError(null);
      navigator.clipboard.writeText(address).then(
        () => {
          toast({ title: 'Address copied', tone: 'ok' });
        },
        () => {
          setError(
            'The address could not be copied. Open the wallet details, select it and copy it by hand.',
          );
        },
      );
    },
    [toast],
  );

  const selectedIndices = info.wallets.filter((w) => active[w.index] ?? true).map((w) => w.index);
  const selectedCount = selectedIndices.length;
  const summary = summarize(
    info.wallets.map((w) => {
      const balance = balances.lamports?.get(w.index) ?? null;
      return {
        balance,
        maxSpend: plannedSpend(
          walletTrade(info.settings.trade, w.index, savedMaxSpend.get(w.index)).buyAmount,
          balance,
          info.settings.global.minReserveLamports,
        ),
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

  // Wallets whose trade settings stay until their group's action ends: every wallet of an
  // armed watcher's group, and the wallets of a running buy or sell (D-045, D-046).
  const groupsStatus = status?.groups;
  const runRows = buyView.rows;
  const locked = useMemo(() => {
    const out = new Set<number>();
    if (!groupsStatus) return out;
    const groups =
      info.settings.groups.length > 0
        ? info.settings.groups
        : [{ id: 'g1', wallets: info.wallets.map((w) => w.index) }];
    for (const g of groupsStatus) {
      const members = groups.find((x) => x.id === g.id)?.wallets ?? [];
      for (const index of members) {
        if (g.watch?.armed === true || (g.buy !== null && runRows.has(index))) out.add(index);
      }
    }
    return out;
  }, [groupsStatus, runRows, info.settings.groups, info.wallets]);

  const saveTable = async (): Promise<void> => {
    if (!tableDirty || phase.kind === 'unsaved' || phase.kind === 'adding') return;
    // Wallets without an entry are active (D-019): store only the inactive ones.
    const inactive = info.wallets
      .filter((w) => active[w.index] === false)
      .map((w) => ({ index: w.index, active: false }));
    setError(null);
    setPhase({ kind: 'savingTable' });
    try {
      const result = await client.request({
        type: 'saveSettings',
        settings: {
          maxSpend: info.settings.maxSpend,
          active: inactive,
          global: info.settings.global,
        },
      });
      setPhase({
        kind: 'unsaved',
        fileText: result.fileText,
        fleetName: result.info.fleetName,
        note: 'The selected wallets are saved in the vault.',
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

  // Why "Create wallets" is off right now, in words next to the button.
  const createBlocked = watchArmed
    ? WATCH_FROZEN
    : phase.kind === 'unsaved' || tableDirty
      ? 'Save the table changes and the updated fleet file first, then create wallets.'
      : room === 0
        ? `The fleet already has the maximum of ${String(MAX_WALLETS)} wallets.`
        : null;

  const add = async (count: number): Promise<boolean> => {
    if (createBlocked !== null || phase.kind === 'adding') return false;
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
      await refresh();
      return true;
    } catch (e) {
      setError(toUserMessage(e));
      setPhase({ kind: 'idle' });
      return false;
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
      <div className="inline balances-bar">
        <span className="muted" aria-live="polite">
          {balances.fetchedAt
            ? `Balances as of ${new Date(balances.fetchedAt).toLocaleTimeString('en-GB')}`
            : 'Balances: loading…'}
        </span>
        <Button onClick={balances.refresh}>Refresh balances</Button>
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
          <Input
            id={`${ids}-mint`}
            value={mintText}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={mintError !== null}
            aria-describedby={`${ids}-mint-help`}
            onChange={(e) => {
              setMintText(e.target.value);
            }}
          />
          <Button type="submit">Show token balance</Button>
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

      <FleetTable
        wallets={info.wallets}
        lamports={balances.lamports}
        token={balances.token}
        maxSpend={savedMaxSpend}
        trade={info.settings.trade}
        locked={locked}
        selected={active}
        minReserve={info.settings.global.minReserveLamports}
        onTrade={onTrade}
        onSelect={onSelect}
        onSelectAll={onSelectAll}
        onCopy={onCopy}
        probe={rowProbe}
        buy={buyView.run === null ? null : buyView.rows}
        explorer={global.explorer}
        network={global.network}
        tools={
          <>
            <CreateWallets room={room} limit={MAX_WALLETS} blocked={createBlocked} onCreate={add} />
            <EditSelected
              count={selectedCount}
              onSave={(patch) => saveTrade(selectedIndices, patch)}
            />
          </>
        }
      />
      <FleetSummaryBar
        summary={summary}
        walletCount={info.wallets.length}
        selectedCount={selectedCount}
        tokenDecimals={balances.token?.decimals ?? null}
        firstFillMs={buyView.run?.firstConfirmMs ?? null}
        lastFillMs={buyView.run?.lastConfirmMs ?? null}
      />
      <div className="actions">
        <Button
          variant="primary"
          disabled={watchArmed || !tableDirty || (phase.kind !== 'idle' && phase.kind !== 'saved')}
          onClick={() => void saveTable()}
        >
          {phase.kind === 'savingTable' ? 'Saving…' : 'Save table changes'}
        </Button>
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
            <Button variant="primary" disabled={phase.saving} onClick={() => void save(phase)}>
              {phase.saving ? 'Saving…' : 'Save the updated fleet file'}
            </Button>
          </div>
        </div>
      )}
      {phase.kind === 'saved' && (
        <p className="notice" role="status">
          Saved {phase.result.fileName} {phase.savedNote}.
        </p>
      )}

      <h3>Backup</h3>
      <p className="muted">
        The only way to get a copy of the recovery phrase and the private keys is a plain export
        after typing the password again.
      </p>
      {/* The opener stays mounted: the dialog gives the focus back to it. */}
      <div className="actions">
        <Button
          aria-expanded={exportOpen}
          onClick={() => {
            setExportOpen(true);
          }}
        >
          Plain export (recovery phrase and keys)
        </Button>
      </div>
      {exportOpen && (
        <ExportDialog
          storage={storage}
          onClose={() => {
            setExportOpen(false);
          }}
        />
      )}
    </section>
  );
}
