import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { toUserMessage } from '../../core/errors.ts';
import { NETWORK_LABELS, NO_BUY_ROUTE_MESSAGE, buyRouteOf } from '../../core/network.ts';
import { effectiveJupiterPlan } from '../../core/settings.ts';
import { walletTrade } from '../../core/trade.ts';
import {
  saveKeystoreFile,
  supportsDirectoryPicker,
  type SaveResult,
  type StorageEnv,
} from '../../storage/keystore-file.ts';
import type { VaultInfo } from '../../worker/protocol.ts';
import { BuyPanel } from '../BuyPanel.tsx';
import { CommandBar, type CommandReasons, type Target } from '../CommandBar.tsx';
import { CreateWallets } from '../CreateWallets.tsx';
import { ExportDialog } from '../ExportDialog.tsx';
import { FleetBulk, FleetSummaryBar } from '../FleetBulk.tsx';
import { shareOf, summarize } from '../fleet-math.ts';
import { FleetTable } from '../FleetTable.tsx';
import type { OperationsLog } from '../operations-log.ts';
import { OperationsLogPanel } from '../OperationsLogPanel.tsx';
import { SettingsResetNotice } from '../SettingsResetNotice.tsx';
import { formatSol, parseSolAmount } from '../sol.ts';
import { useBalances } from '../use-balances.ts';
import { EMPTY_BUY, isBuyRunning, type BuyRow, type BuyView } from '../use-buy.ts';
import { useVault } from '../vault-state.ts';
import { WATCH_FROZEN } from '../watch-labels.ts';
import { useWatchRuntime } from '../watch-runtime.ts';
import { Button, Modal, useToast } from '../kit/index.ts';

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

/** Shown in a row from the click until the worker's first event of the new buy. */
const QUEUED_ROW: BuyRow = {
  state: 'QUEUED',
  attempt: 0,
  reason: null,
  quote: null,
  result: null,
  sinceStartMs: 0,
  verify: null,
};

const NO_READY = 'No ready wallets: select wallets that have a saved max spend.';

const CONFIRM_TITLES = {
  buy: 'Buy in live mode?',
  sell: 'Sell in live mode?',
  arm: 'Arm the watcher in live mode?',
} as const;
const CONFIRM_YES = { buy: 'Yes, buy', sell: 'Yes, sell', arm: 'Yes, arm' } as const;

/** A command waiting for the live-mode confirmation. */
type Confirm =
  | { readonly kind: 'buy'; readonly mint: string; readonly wallets: readonly number[] }
  | { readonly kind: 'sell'; readonly mint: string; readonly wallets: readonly number[] }
  | { readonly kind: 'arm'; readonly creator: string; readonly wallets: readonly number[] };

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
  const { alarm } = useWatchRuntime();
  const [target, setTarget] = useState<Target | null>(null);
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
  const [exportOpen, setExportOpen] = useState(false);
  const toast = useToast();
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
  const maxSpendDirty = info.wallets.some(
    (w) => draftLamports(w.index) !== (savedMaxSpend.get(w.index) ?? null),
  );
  const tableDirty =
    maxSpendDirty ||
    info.wallets.some((w) => (active[w.index] ?? true) !== (savedActive[w.index] ?? true));
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

  const onMaxSpend = useCallback((index: number, text: string) => {
    setMaxSpendText((d) => ({ ...d, [index]: text }));
  }, []);
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
  const unknownBalances = info.wallets.filter((w) => !balances.lamports?.has(w.index)).length;

  // A buy or an arming uses exactly these wallets, saved in the file or not (BUNNDLY-59).
  const selectedIndexes = useMemo(
    () => info.wallets.filter((w) => active[w.index] ?? true).map((w) => w.index),
    [info.wallets, active],
  );
  const selectedCount = selectedIndexes.length;
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

  const { global } = info.settings;
  const hasRpc = info.apiKeys.helius || info.apiKeys.heliusRpcUrl;
  const buyBlocked =
    buyRouteOf(global.network) === null
      ? NO_BUY_ROUTE_MESSAGE
      : maxSpendDirty
        ? 'Save the max spend changes first: a buy spends the amounts saved in the vault.'
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
        note: 'The table changes (max spend, selected wallets) are saved in the vault.',
        savedNote: 'with the new fleet settings',
        saving: false,
      });
      await refresh();
    } catch (e) {
      setError(toUserMessage(e));
      setPhase({ kind: 'idle' });
    }
  };

  // The target field (BUNNDLY-59): a checked mint also shows its balances in the table.
  const onTarget = useCallback((next: Target | null) => {
    setTarget(next);
    setMintError(null);
    setMint(next?.kind.kind === 'mint' ? next.address : null);
  }, []);

  // --- Commands (BUNNDLY-59): the request names the selected wallets. ---
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [commandBusy, setCommandBusy] = useState(false);
  const [commandError, setCommandError] = useState<string | null>(null);
  /** Rows shown as queued at once; `since` is the run the table showed at the click. */
  const [pending, setPending] = useState<{
    readonly wallets: ReadonlySet<number>;
    readonly since: number | null;
  } | null>(null);
  const runId = buyView.run?.runId ?? null;
  // The worker's events of the new buy replace the queued rows.
  const queued = pending !== null && pending.since === runId ? pending.wallets : null;

  const running = isBuyRunning(buyView, status?.buy ?? null);
  const stopping = buyView.run?.phase === 'stopping' || status?.buy?.accepting === false;
  const detected = useMemo(
    () => status?.watch?.detections.filter((d) => d.problem === null).at(-1) ?? null,
    [status?.watch?.detections],
  );
  const buyMint = target?.kind.kind === 'mint' ? target.address : (detected?.mint ?? null);
  // A buy spends the saved amounts: the selected wallets that have one.
  const readyIndexes = selectedIndexes.filter((i) => (savedMaxSpend.get(i) ?? 0n) > 0n);
  const hasWatcherKeys =
    (info.apiKeys.helius || info.apiKeys.heliusWsUrl) &&
    (info.apiKeys.helius || info.apiKeys.heliusRpcUrl);
  const reasons: CommandReasons = {
    buy: running
      ? 'A buy is running. Wait for it to end or press STOP.'
      : commandBusy
        ? 'Sending the command…'
        : (buyBlocked ??
          (buyMint === null
            ? target?.kind.kind === 'wallet'
              ? 'BUY needs a token: arm the watcher and wait for this creator’s token, or paste a mint.'
              : 'Paste a token mint first.'
            : readyIndexes.length === 0
              ? NO_READY
              : null)),
    arm: running
      ? 'A buy is running: you can arm the watcher when it ends.'
      : commandBusy
        ? 'Sending the command…'
        : buyRouteOf(global.network) === null
          ? NO_BUY_ROUTE_MESSAGE
          : maxSpendDirty
            ? 'Save the max spend changes first: the watcher spends the amounts saved in the vault.'
            : target?.kind.kind !== 'wallet'
              ? target === null
                ? 'Paste a creator wallet first.'
                : 'ARM needs a creator wallet, not a token.'
              : !hasWatcherKeys
                ? 'The watcher needs a Helius key (Settings).'
                : readyIndexes.length === 0
                  ? NO_READY
                  : null,
    sell: running
      ? 'A buy or sell is running. Wait for it to end or press STOP.'
      : commandBusy
        ? 'Sending the command…'
        : buyRouteOf(global.network) === null
          ? NO_BUY_ROUTE_MESSAGE
          : watchArmed
            ? 'DISARM first: the armed watcher may buy this token at any moment.'
            : buyMint === null
              ? 'Paste the mint of the token to sell.'
              : !hasRpc
                ? 'Selling reads the token balances first: it needs a Helius key (Settings).'
                : selectedIndexes.length === 0
                  ? 'Select the wallets that sell.'
                  : null,
    stop: !running ? 'Nothing is running.' : stopping ? 'Stopping…' : null,
  };

  const command = async (task: () => Promise<unknown>): Promise<boolean> => {
    setCommandError(null);
    setCommandBusy(true);
    try {
      await task();
      return true;
    } catch (e) {
      setCommandError(toUserMessage(e));
      return false;
    } finally {
      setCommandBusy(false);
    }
  };
  const launchBuy = (buyFor: string, wallets: readonly number[]): void => {
    // The rows change in this click, before the worker answers.
    setPending({
      wallets: new Set(wallets.filter((i) => (savedMaxSpend.get(i) ?? 0n) > 0n)),
      since: runId,
    });
    void command(async () => {
      try {
        await client.request({ type: 'startBuy', mint: buyFor, wallets });
      } catch (e) {
        setPending(null); // refused: the rows go back to what they were
        throw e;
      }
      await refresh();
    });
  };
  const requestBuy = (wallets: readonly number[]): void => {
    if (buyMint === null) return;
    if (global.dryRun) launchBuy(buyMint, wallets);
    else setConfirm({ kind: 'buy', mint: buyMint, wallets });
  };
  // SELL (BUNNDLY-60): each selected wallet sells its set part of its token balance.
  const launchSell = (mint: string, wallets: readonly number[]): void => {
    setPending({ wallets: new Set(wallets), since: runId });
    void command(async () => {
      try {
        await client.request({ type: 'startSell', mint, wallets });
      } catch (e) {
        setPending(null);
        throw e;
      }
      await refresh();
    });
  };
  const onSell = (): void => {
    if (reasons.sell !== null || buyMint === null) return;
    if (global.dryRun) launchSell(buyMint, selectedIndexes);
    else setConfirm({ kind: 'sell', mint: buyMint, wallets: selectedIndexes });
  };
  const launchArm = (creator: string, wallets: readonly number[]): void => {
    alarm.prime(); // the click allows the alarm sound later (autoplay policy)
    void command(async () => {
      await client.request({ type: 'arm', creator, wallets });
      await refresh();
    });
  };
  const onBuy = (): void => {
    if (reasons.buy === null) requestBuy(selectedIndexes);
  };
  const onArm = (): void => {
    if (reasons.arm !== null || target === null) return;
    if (global.dryRun) launchArm(target.address, selectedIndexes);
    else setConfirm({ kind: 'arm', creator: target.address, wallets: selectedIndexes });
  };
  const onDisarm = (): void => {
    void command(async () => {
      await client.request({ type: 'disarm' });
      await refresh();
    });
  };
  const onStop = (): void => {
    if (reasons.stop !== null) return;
    void command(async () => {
      await client.request({ type: 'stop' });
      await refresh();
    });
  };
  // Row action: the same request with one wallet. Stable for the memoized rows.
  const rowBuy = useRef(requestBuy);
  useEffect(() => {
    rowBuy.current = requestBuy;
  });
  const onBuyWallet = useCallback((index: number) => {
    rowBuy.current([index]);
  }, []);
  const confirmSpend = (wallets: readonly number[]): bigint =>
    wallets.reduce((sum, i) => sum + (savedMaxSpend.get(i) ?? 0n), 0n);
  /** The part each wallet sells (BUNNDLY-58 sets it per wallet): one value or a range. */
  const sellPart = (wallets: readonly number[]): string => {
    const parts = wallets.map((i) => walletTrade(info.settings.trade, i, undefined).sellPercent);
    const low = Math.min(...parts);
    const high = Math.max(...parts);
    return low === high ? `${String(low)}%` : `${String(low)}–${String(high)}%`;
  };
  const confirmReady = (wallets: readonly number[]): number =>
    wallets.filter((i) => (savedMaxSpend.get(i) ?? 0n) > 0n).length;
  const tableBuy = useMemo(() => {
    const rows = buyView.run === null ? null : buyView.rows;
    if (queued === null) return rows;
    const next = new Map(rows ?? []);
    for (const i of queued) next.set(i, QUEUED_ROW);
    return next;
  }, [buyView.run, buyView.rows, queued]);
  const inFleet = target?.kind.kind === 'wallet' && fleetAddresses.includes(target.address);

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

      {mintError && (
        <p className="notice error" role="alert">
          {mintError}
        </p>
      )}

      <BuyPanel
        view={buyView}
        readyCount={summary.readyCount}
        toSpend={summary.toSpendLamports}
        dryRun={global.dryRun}
        plan={effectiveJupiterPlan(global, info.apiKeys.jupiter)}
        onDryRun={setDryRun}
        watchMode={global.mode}
        onWatchMode={setWatchMode}
      >
        {operationsLog && (
          <OperationsLogPanel log={operationsLog} storage={storage} decimals={buyDecimals} />
        )}
      </BuyPanel>

      <CommandBar
        dryRun={global.dryRun}
        armed={watchArmed}
        busy={commandBusy}
        reasons={reasons}
        blocked={buyBlocked}
        detected={detected}
        onTarget={onTarget}
        onBuy={onBuy}
        onSell={onSell}
        onArm={onArm}
        onDisarm={onDisarm}
        onStop={onStop}
      />
      {inFleet && (
        <p className="notice warning" role="status">
          This is a wallet from this fleet. Make sure you want to watch your own wallet.
        </p>
      )}
      {commandError && (
        <p className="notice error" role="alert">
          {commandError}
        </p>
      )}
      {confirm && (
        <Modal
          open
          role="alertdialog"
          tone="danger"
          title={CONFIRM_TITLES[confirm.kind]}
          onClose={() => {
            setConfirm(null);
          }}
          footer={
            <>
              <Button
                variant="ghost"
                onClick={() => {
                  setConfirm(null);
                }}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  setConfirm(null);
                  if (confirm.kind === 'buy') launchBuy(confirm.mint, confirm.wallets);
                  else if (confirm.kind === 'sell') launchSell(confirm.mint, confirm.wallets);
                  else launchArm(confirm.creator, confirm.wallets);
                }}
              >
                {CONFIRM_YES[confirm.kind]}
              </Button>
            </>
          }
        >
          <dl className="summary" aria-label="What the command does">
            <div>
              <dt>Wallets</dt>
              <dd>
                {confirm.kind === 'sell' ? confirm.wallets.length : confirmReady(confirm.wallets)}
              </dd>
            </div>
            {confirm.kind === 'sell' ? (
              <div>
                <dt>To sell</dt>
                <dd>{sellPart(confirm.wallets)} of each token balance</dd>
              </div>
            ) : (
              <div>
                <dt>{confirm.kind === 'buy' ? 'Total to spend' : 'To spend per token'}</dt>
                <dd>up to {formatSol(confirmSpend(confirm.wallets))} SOL</dd>
              </div>
            )}
            <div>
              <dt>Network</dt>
              <dd>{NETWORK_LABELS[global.network]}</dd>
            </div>
            <div>
              <dt>Execution</dt>
              <dd>
                live: real transactions
                {confirm.kind === 'arm' &&
                  (global.mode === 'continuous'
                    ? ', a buy for every new token'
                    : ', one buy, then the watcher disarms')}
              </dd>
            </div>
          </dl>
          <p>On-chain transactions cannot be undone.</p>
        </Modal>
      )}

      <FleetBulk
        onAmount={setAllAmount}
        onPercent={setAllPercent}
        unknownBalances={unknownBalances}
      />

      <FleetTable
        wallets={info.wallets}
        lamports={balances.lamports}
        token={balances.token}
        maxSpendText={maxSpendText}
        selected={active}
        minReserve={info.settings.global.minReserveLamports}
        onMaxSpend={onMaxSpend}
        onSelect={onSelect}
        onSelectAll={onSelectAll}
        onCopy={onCopy}
        probe={rowProbe}
        buy={tableBuy}
        onBuyWallet={onBuyWallet}
        rowBuyBlocked={reasons.buy === NO_READY ? null : reasons.buy}
        explorer={global.explorer}
        network={global.network}
        tools={
          <CreateWallets room={room} limit={MAX_WALLETS} blocked={createBlocked} onCreate={add} />
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
          disabled={
            watchArmed ||
            !tableDirty ||
            tableInvalid ||
            (phase.kind !== 'idle' && phase.kind !== 'saved')
          }
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
