import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { isAppError, toUserMessage } from '../../core/errors.ts';
import { effectiveGroups, groupOf, type WalletGroupV1 } from '../../core/groups.ts';
import type { FleetSettingsV1 } from '../../core/keystore/format.ts';
import { NETWORK_LABELS, NO_BUY_ROUTE_MESSAGE, buyRouteOf } from '../../core/network.ts';
import { walletTrade } from '../../core/trade.ts';
import {
  saveKeystoreFile,
  supportsDirectoryPicker,
  type SaveResult,
  type StorageEnv,
} from '../../storage/keystore-file.ts';
import type { BuyStatus, GroupStatus, VaultInfo } from '../../worker/protocol.ts';
import {
  CommandBar,
  CommandButtons,
  type CommandReasons,
  type Target,
  type TargetCheck,
} from '../CommandBar.tsx';
import { ARM_TARGET, BUY_TARGET, SELL_TARGET, targetReason } from '../target-reasons.ts';
import { CreateWallets } from '../CreateWallets.tsx';
import type { StairsOptions, WalletState } from '../../executor/index.ts';
import { fillOf, fleetFill, type Fill } from '../fill.ts';
import { FleetSegments, FleetSummaryBar } from '../FleetSummaryBar.tsx';
import { summarize } from '../fleet-math.ts';
import { FleetTable } from '../FleetTable.tsx';
import {
  deleteGroup,
  groupLamports,
  groupState,
  moveWallets,
  renameGroup,
  type MoveTarget,
} from '../group-view.ts';
import { GroupTabs, MoveToGroup } from '../GroupTabs.tsx';
import { ModeSwitch } from '../ModeSwitch.tsx';
import { useHeaderSlots } from '../header-slots.ts';
import { SettingsResetNotice } from '../SettingsResetNotice.tsx';
import {
  parseEvery,
  parsePerStep,
  pauseControl,
  planText,
  stairsPlan,
  stairsProblem,
  stairsRequest,
} from '../stairs-plan.ts';
import { StairsStrip } from '../StairsStrip.tsx';
import { formatSol } from '../sol.ts';
import { LOCKED_HINT, applyWalletPatch, plannedSpend, type WalletPatch } from '../trade-edit.ts';
import { useBalances } from '../use-balances.ts';
import { EMPTY_BUY, type BuyRow, type BuyView } from '../use-buy.ts';
import { reportSaved } from '../use-pending-file.ts';
import { useVault } from '../vault-state.ts';
import { WATCH_FROZEN } from '../watch-labels.ts';
import { useWatchRuntime } from '../watch-runtime.ts';
import { EditSelected } from '../WalletTradeFields.tsx';
import { Button, Modal, PauseIcon, PlayIcon, Segmented, SolIcon, useToast } from '../kit/index.ts';

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
  /** Progress of the current or last buy (BUNNDLY-27), kept by the app across screens. */
  readonly buyView?: BuyView;
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

const NO_READY = 'No ready wallets: select wallets that have a buy amount.';
/** How long the rail says what a command did (BUNNDLY-90, Andy's interim decision). */
const SAY_MS = 4_200;

const walletsText = (n: number): string => `${String(n)} wallet${n === 1 ? '' : 's'}`;

/** "Wallet 4–8" for labels that differ only in their last number; "A–B" otherwise. */
function labelRange(first: string, last: string): string {
  if (first === last) return first;
  const a = /^(.*?)(\d+)$/u.exec(first);
  const b = /^(.*?)(\d+)$/u.exec(last);
  if (a && b && a[1] === b[1]) return `${first}–${b[2] ?? ''}`;
  return `${first}–${last}`;
}

/** States in which STOP leaves a wallet without sending. */
const NOT_SENT: ReadonlySet<WalletState> = new Set(['IDLE', 'SCHEDULED', 'QUEUED']);

/** "Stopped · 4 wallets did not send"; an armed group says it is disarmed (BUNNDLY-87). */
function stoppedText(notSent: number, armed: boolean): string {
  const parts = ['Stopped'];
  if (armed) parts.push('the group is disarmed');
  if (notSent > 0) parts.push(`${walletsText(notSent)} did not send`);
  return parts.join(' · ');
}

/** "Buy started on 3 wallets · Stairs · DRY-RUN", from what the worker accepted. */
function startedText(side: 'Buy' | 'Sell', run: BuyStatus): string {
  const mode = run.stairs ? 'Stairs' : 'Immediate';
  return `${side} started on ${walletsText(run.wallets)} · ${mode}${run.dryRun ? ' · DRY-RUN' : ''}`;
}
const PICK_GROUP = 'Pick a group tab: the commands act on one group at a time.';
/** Why Immediate / Stairs cannot change now (BUNNDLY-93, the mockup's words). */
const MODE_LOCKED = 'The mode can change once the current run ends.';
/** Why a running group keeps its wallets, its amounts and its name (BUNNDLY-68). */
const runningText = (name: string): string =>
  `${name} is running: wait for it to end or press STOP.`;
/** Why an armed group neither buys nor sells by hand: its watcher buys (BUNNDLY-86). */
const ARMED_TEXT = 'DISARM first: the armed watcher may buy this token at any moment.';

const CONFIRM_TITLES = {
  buy: 'Buy in live mode?',
  sell: 'Sell in live mode?',
  arm: 'Arm the watcher in live mode?',
} as const;
const CONFIRM_YES = { buy: 'Yes, buy', sell: 'Yes, sell', arm: 'Yes, arm' } as const;

/** A command waiting for the live-mode confirmation. */
type Confirm = {
  readonly group: WalletGroupV1;
  readonly wallets: readonly number[];
  /** The bar's Stairs steps (BUNNDLY-61); absent: Immediate. */
  readonly stairs?: StairsOptions | undefined;
} & (
  | { readonly kind: 'buy'; readonly mint: string }
  | { readonly kind: 'sell'; readonly mint: string }
  | { readonly kind: 'arm'; readonly creator: string }
);

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
  buyView = EMPTY_BUY,
  onMintDecimals,
}: FleetScreenProps) {
  const { client, status, refresh } = useVault();
  const watchArmed = status?.watch?.armed ?? false;
  const { alarm } = useWatchRuntime();
  const [targetCheck, setTargetCheck] = useState<TargetCheck>({ kind: 'empty' });
  const target: Target | null = targetCheck.kind === 'done' ? targetCheck.target : null;
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
  const toast = useToast();
  const [phase, setPhase] = useState<AddPhase>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  // --- Wallet groups (BUNNDLY-69): the tabs, and the group the commands act on. ---
  const groups = useMemo(
    () =>
      effectiveGroups(
        info.settings.groups,
        info.wallets.map((w) => w.index),
      ),
    [info],
  );
  const [tabChoice, setTabChoice] = useState<string | null>(() => groups[0]?.id ?? null);
  // A deleted group's tab falls back to the first group.
  const tab =
    tabChoice === null || groups.some((g) => g.id === tabChoice)
      ? tabChoice
      : (groups[0]?.id ?? null);
  const shownGroup = groups.find((g) => g.id === tab) ?? null;
  // "All" with one group acts on that group; with more, a tab must be picked.
  const commandGroup =
    tab === null ? (groups.length === 1 ? (groups[0] ?? null) : null) : shownGroup;
  const groupStatus = (id: string): GroupStatus | undefined =>
    status?.groups.find((g) => g.id === id);
  const busyBlock = (id: string): string | null => {
    if (groupStatus(id)?.armed !== true) return null;
    return runningText(groups.find((g) => g.id === id)?.name ?? id);
  };
  const commandStatus = commandGroup ? groupStatus(commandGroup.id) : undefined;
  const groupArmed = commandStatus?.watch?.armed ?? false;
  /** The target field's text per tab: each group keeps its own target. */
  const [targetTexts, setTargetTexts] = useState<Readonly<Record<string, string>>>({});
  const barKey = tab ?? '';
  const onTargetText = useCallback(
    (text: string) => {
      setTargetTexts((t) => ({ ...t, [barKey]: text }));
    },
    [barKey],
  );

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
  const minReserve = info.settings.global.minReserveLamports;
  /** The amount a wallet buys with (its own or the fleet default, SOL or %), or null. */
  const buyAmountOf = (index: number) =>
    walletTrade(info.settings.trade, index, savedMaxSpend.get(index)).buyAmount;
  /** What a buy would spend now: a percent counted from the balance read last. */
  const spendOf = (index: number): bigint | null =>
    plannedSpend(buyAmountOf(index), balances.lamports?.get(index) ?? null, minReserve);
  /** A wallet with an amount takes part in a buy; a percent is counted at the start (D-045). */
  const hasAmount = (index: number): boolean => {
    const amount = buyAmountOf(index);
    return amount !== null && (amount.kind === 'percent' || amount.lamports > 0n);
  };

  const unsaved = phase.kind === 'unsaved' || tableDirty;
  // Layout effect: the guard holds from the commit that shows the change (BUNNDLY-76).
  useLayoutEffect(() => {
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

  // A buy or an arming uses exactly these wallets, saved in the file or not (BUNNDLY-59),
  // of the group it runs in (BUNNDLY-69).
  const selectedIndexes = useMemo(
    () => info.wallets.filter((w) => active[w.index] ?? true).map((w) => w.index),
    [info.wallets, active],
  );
  const selectedCount = selectedIndexes.length;
  const groupSelected = commandGroup
    ? selectedIndexes.filter((i) => commandGroup.wallets.includes(i))
    : [];
  const summary = summarize(
    info.wallets.map((w) => ({
      balance: balances.lamports?.get(w.index) ?? null,
      maxSpend: spendOf(w.index),
      minReserve,
      active: active[w.index] ?? true,
      token: balances.token?.amounts.get(w.index) ?? null,
    })),
  );

  const { global } = info.settings;
  const hasRpc = info.apiKeys.helius || info.apiKeys.heliusRpcUrl;
  const buyBlocked =
    buyRouteOf(global.network) === null
      ? NO_BUY_ROUTE_MESSAGE
      : !global.dryRun && !hasRpc
        ? 'Live mode needs a Helius key (Settings).'
        : null;
  const token = balances.token;
  useEffect(() => {
    if (token) onMintDecimals?.(token.mint, token.decimals);
  }, [token, onMintDecimals]);
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

  const fleetAddresses = useMemo(() => info.wallets.map((w) => w.address), [info.wallets]);

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

  // The target field (BUNNDLY-59): a checked mint also shows its balances in the table.
  const onTargetCheck = useCallback((check: TargetCheck) => {
    setTargetCheck(check);
    setMintError(null);
    setMint(
      check.kind === 'done' && check.target.kind.kind === 'mint' ? check.target.address : null,
    );
  }, []);

  // --- Commands (BUNNDLY-59): the request names the selected wallets. ---
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [commandBusy, setCommandBusy] = useState(false);
  const [commandError, setCommandError] = useState<string | null>(null);
  // Immediate or Stairs for the bar's BUY, SELL and ARM (BUNNDLY-61, mockup v2); a row
  // action trades its one wallet at once. Stairs, every 6 s, 1 per step, like the mockup
  // (BUNNDLY-93, Andy's interim decision).
  const [execMode, setExecMode] = useState<'immediate' | 'stairs'>('stairs');
  const [everyText, setEveryText] = useState('6');
  const [perStepText, setPerStepText] = useState('1');
  const stairsBad = execMode === 'stairs' ? stairsProblem(everyText, perStepText) : null;
  const barStairs = (): StairsOptions | undefined => {
    const every = parseEvery(everyText);
    const perStep = parsePerStep(perStepText);
    if (execMode !== 'stairs' || every === null || perStep === null) return undefined;
    return stairsRequest(every, perStep);
  };
  /** Rows shown as queued at once; `since` is the run the table showed at the click. */
  const [pending, setPending] = useState<{
    readonly wallets: ReadonlySet<number>;
    readonly since: number | null;
  } | null>(null);
  const runId = buyView.run?.runId ?? null;
  // The worker's events of the new buy replace the queued rows.
  const queued = pending !== null && pending.since === runId ? pending.wallets : null;

  // The newest run in the table belongs to the group whose status names it; one that no
  // status shows yet (just started) counts as running everywhere until the next status.
  const viewRun = buyView.run;
  const viewRunClaimed =
    viewRun !== null && (status?.groups ?? []).some((g) => g.buy?.runId === viewRun.runId);
  const unclaimedRun = viewRun !== null && !viewRunClaimed && viewRun.phase !== 'finished';
  const groupRunning = (gs: GroupStatus | undefined): boolean => {
    if (unclaimedRun) return true;
    const buy = gs?.buy ?? null;
    if (buy === null) return false;
    return !(viewRun?.runId === buy.runId && viewRun.phase === 'finished');
  };
  const running = groupRunning(commandStatus);
  const stopping =
    commandStatus?.buy?.accepting === false ||
    (viewRun?.phase === 'stopping' && viewRun.runId === commandStatus?.buy?.runId);
  const groupDetections = commandStatus?.watch?.detections;
  const detected = useMemo(
    () => groupDetections?.filter((d) => d.problem === null).at(-1) ?? null,
    [groupDetections],
  );
  const buyMint = target?.kind.kind === 'mint' ? target.address : (detected?.mint ?? null);
  // A buy spends the saved amounts: the selected wallets that have one.
  const readyIndexes = groupSelected.filter(hasAmount);
  const hasWatcherKeys =
    (info.apiKeys.helius || info.apiKeys.heliusWsUrl) &&
    (info.apiKeys.helius || info.apiKeys.heliusRpcUrl);
  const groupReasons: CommandReasons = {
    buy: running
      ? 'A buy is running. Wait for it to end or press STOP.'
      : commandBusy
        ? 'Sending the command…'
        : groupArmed
          ? ARMED_TEXT
          : (buyBlocked ??
            (buyMint === null
              ? targetReason(targetCheck, BUY_TARGET)
              : readyIndexes.length === 0
                ? NO_READY
                : null)),
    arm: running
      ? 'A buy is running: you can arm the watcher when it ends.'
      : commandBusy
        ? 'Sending the command…'
        : buyRouteOf(global.network) === null
          ? NO_BUY_ROUTE_MESSAGE
          : target?.kind.kind !== 'wallet'
            ? targetReason(targetCheck, ARM_TARGET)
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
          : groupArmed
            ? ARMED_TEXT
            : buyMint === null
              ? targetReason(targetCheck, SELL_TARGET)
              : !hasRpc
                ? 'Selling reads the token balances first: it needs a Helius key (Settings).'
                : groupSelected.length === 0
                  ? 'Select the wallets that sell.'
                  : null,
    // STOP also disarms an armed group (BUNNDLY-87): on while it buys or is armed.
    stop:
      running && stopping && !groupArmed
        ? 'Stopping…'
        : running || groupArmed
          ? null
          : 'Nothing is running.',
  };
  const reasons: CommandReasons =
    commandGroup === null
      ? { buy: PICK_GROUP, arm: PICK_GROUP, sell: PICK_GROUP, stop: PICK_GROUP }
      : {
          ...groupReasons,
          buy: groupReasons.buy ?? stairsBad,
          sell: groupReasons.sell ?? stairsBad,
          arm: groupReasons.arm ?? stairsBad,
        };

  // The rail's message line (BUNNDLY-90): said only after the worker accepted the command;
  // a refusal stays in the command error. A newer message restarts the 4.2 s.
  const [said, setSaid] = useState<{ readonly text: string; readonly n: number } | null>(null);
  const say = useCallback((text: string) => {
    setSaid((before) => ({ text, n: (before?.n ?? 0) + 1 }));
  }, []);
  useEffect(() => {
    if (said === null) return;
    const id = window.setTimeout(() => {
      setSaid(null);
    }, SAY_MS);
    return () => {
      window.clearTimeout(id);
    };
  }, [said]);

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
  const launchBuy = (
    buyFor: string,
    group: string,
    wallets: readonly number[],
    stairs?: StairsOptions,
  ): void => {
    // The rows change in this click, before the worker answers.
    setPending({
      wallets: new Set(wallets.filter(hasAmount)),
      since: runId,
    });
    void command(async () => {
      let run: BuyStatus;
      try {
        run = await client.request({
          type: 'startBuy',
          mint: buyFor,
          wallets,
          group,
          ...(stairs ? { stairs } : {}),
        });
      } catch (e) {
        setPending(null); // refused: the rows go back to what they were
        throw e;
      }
      say(startedText('Buy', run));
      await refresh();
    });
  };
  const requestBuy = (
    group: WalletGroupV1,
    wallets: readonly number[],
    stairs?: StairsOptions,
  ): void => {
    if (buyMint === null) return;
    if (global.dryRun) launchBuy(buyMint, group.id, wallets, stairs);
    else setConfirm({ kind: 'buy', mint: buyMint, group, wallets, stairs });
  };
  // SELL (BUNNDLY-60): each selected wallet sells its set part of its token balance.
  const launchSell = (
    mint: string,
    group: string,
    wallets: readonly number[],
    stairs?: StairsOptions,
  ): void => {
    setPending({ wallets: new Set(wallets), since: runId });
    void command(async () => {
      let run: BuyStatus;
      try {
        run = await client.request({
          type: 'startSell',
          mint,
          wallets,
          group,
          ...(stairs ? { stairs } : {}),
        });
      } catch (e) {
        setPending(null);
        throw e;
      }
      say(startedText('Sell', run));
      await refresh();
    });
  };
  const onSell = (): void => {
    if (reasons.sell !== null || buyMint === null || commandGroup === null) return;
    const stairs = barStairs();
    if (global.dryRun) launchSell(buyMint, commandGroup.id, groupSelected, stairs);
    else {
      setConfirm({
        kind: 'sell',
        mint: buyMint,
        group: commandGroup,
        wallets: groupSelected,
        stairs,
      });
    }
  };
  const launchArm = (
    creator: string,
    group: string,
    wallets: readonly number[],
    stairs?: StairsOptions,
  ): void => {
    alarm.prime(); // the click allows the alarm sound later (autoplay policy)
    void command(async () => {
      await client.request({ type: 'arm', creator, wallets, group, ...(stairs ? { stairs } : {}) });
      say('Armed · the fleet buys as soon as the creator launches a token');
      await refresh();
    });
  };
  const onBuy = (): void => {
    if (reasons.buy === null && commandGroup !== null) {
      requestBuy(commandGroup, groupSelected, barStairs());
    }
  };
  const onArm = (): void => {
    if (reasons.arm !== null || target === null || commandGroup === null) return;
    const stairs = barStairs();
    if (global.dryRun) launchArm(target.address, commandGroup.id, groupSelected, stairs);
    else {
      setConfirm({
        kind: 'arm',
        creator: target.address,
        group: commandGroup,
        wallets: groupSelected,
        stairs,
      });
    }
  };
  const onDisarm = (): void => {
    if (commandGroup === null) return;
    const group = commandGroup.id;
    void command(async () => {
      await client.request({ type: 'disarm', group });
      say('Disarmed');
      await refresh();
    });
  };
  const onStop = (): void => {
    if (reasons.stop !== null || commandGroup === null) return;
    const group = commandGroup.id;
    // Counted at the click: the wallets of this group's run that have not sent yet. STOP
    // empties the queue and the steps to come; the ones already sending finish (SPEC 3.6).
    const notSent =
      viewRun === null || viewRun.phase === 'finished'
        ? 0
        : [...buyView.rows].filter(
            ([index, row]) => NOT_SENT.has(row.state) && groupOf(groups, index) === group,
          ).length;
    const wasArmed = groupArmed;
    void command(async () => {
      await client.request({ type: 'stop', group });
      say(stoppedText(notSent, wasArmed));
      await refresh();
    });
  };
  // Pause / Resume of the shown group's Stairs run, while wallets wait for a step.
  const commandRun = commandStatus?.buy ?? null;
  const runWaiting =
    viewRun !== null &&
    commandRun?.runId === viewRun.runId &&
    [...buyView.rows.values()].some((r) => r.state === 'SCHEDULED');
  const pause = useMemo(() => pauseControl(commandRun, runWaiting), [commandRun, runWaiting]);
  const onPause = (): void => {
    if (pause === null || commandGroup === null) return;
    const group = commandGroup.id;
    const request = pause.request;
    void command(async () => {
      if (request === 'pauseStairs') {
        await client.request({ type: 'pauseStairs', group });
        say('Paused · wallets already sending will finish');
      } else {
        await client.request({ type: 'resumeStairs', group });
        say('Resumed');
      }
      await refresh();
    });
  };
  // The "Starts in" countdown of scheduled wallets ticks once a second while not paused.
  const counting =
    viewRun !== null &&
    viewRun.paused !== true &&
    [...buyView.rows.values()].some((r) => r.state === 'SCHEDULED');
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!counting) return;
    const tick = (): void => {
      setNow(Date.now());
    };
    const first = window.setTimeout(tick, 0);
    const id = window.setInterval(tick, 1_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
    };
  }, [counting]);
  // Row action: one wallet buys in its own group, whatever tab is shown. Stable for the
  // memoized rows.
  const buyInGroup = (index: number): void => {
    const group = groups.find((g) => g.id === groupOf(groups, index));
    if (group) requestBuy(group, [index]);
  };
  const rowBuy = useRef(buyInGroup);
  useEffect(() => {
    rowBuy.current = buyInGroup;
  });
  const onBuyWallet = useCallback((index: number) => {
    rowBuy.current(index);
  }, []);
  // Row action: one wallet sells its set part in its own group (mockup v2, BUNNDLY-73).
  const sellInGroup = (index: number): void => {
    const group = groups.find((g) => g.id === groupOf(groups, index));
    if (!group || buyMint === null) return;
    if (global.dryRun) launchSell(buyMint, group.id, [index]);
    else setConfirm({ kind: 'sell', mint: buyMint, group, wallets: [index] });
  };
  const rowSell = useRef(sellInGroup);
  useEffect(() => {
    rowSell.current = sellInGroup;
  });
  const onSellWallet = useCallback((index: number) => {
    rowSell.current(index);
  }, []);
  // The row buy needs a mint and no command in flight; a running group's rows say why not.
  const rowBlocked = commandBusy
    ? 'Sending the command…'
    : (buyBlocked ?? (buyMint === null ? targetReason(targetCheck, BUY_TARGET) : null));
  // The row sell reads the token balance first, as SELL on the bar does.
  const rowSellBlocked = commandBusy
    ? 'Sending the command…'
    : buyRouteOf(global.network) === null
      ? NO_BUY_ROUTE_MESSAGE
      : buyMint === null
        ? targetReason(targetCheck, SELL_TARGET)
        : !hasRpc
          ? 'Selling reads the token balances first: it needs a Helius key (Settings).'
          : null;
  const statusGroups = status?.groups;
  const frozen = useMemo(() => {
    const out = new Map<number, string>();
    for (const g of groups) {
      const s = statusGroups?.find((x) => x.id === g.id);
      if (s?.armed !== true) continue;
      // an armed watcher is stopped by DISARM, a buy or a sell by STOP
      const why = s.watch?.armed === true && s.buy === null ? ARMED_TEXT : runningText(g.name);
      for (const i of g.wallets) out.set(i, why);
    }
    return out;
  }, [groups, statusGroups]);
  const groupNames = useMemo(
    () => new Map(groups.flatMap((g) => g.wallets.map((i) => [i, g.name] as const))),
    [groups],
  );
  const confirmSpend = (wallets: readonly number[]): bigint =>
    wallets.reduce((sum, i) => sum + (spendOf(i) ?? 0n), 0n);
  /** The part each wallet sells (BUNNDLY-58 sets it per wallet): one value or a range. */
  const sellPart = (wallets: readonly number[]): string => {
    const parts = wallets.map((i) => walletTrade(info.settings.trade, i, undefined).sellPercent);
    const low = Math.min(...parts);
    const high = Math.max(...parts);
    return low === high ? `${String(low)}%` : `${String(low)}–${String(high)}%`;
  };
  const confirmReady = (wallets: readonly number[]): number => wallets.filter(hasAmount).length;
  const tableBuy = useMemo(() => {
    const rows = buyView.run === null ? null : buyView.rows;
    if (queued === null) return rows;
    const next = new Map(rows ?? []);
    for (const i of queued) next.set(i, QUEUED_ROW);
    return next;
  }, [buyView.run, buyView.rows, queued]);
  const inFleet = target?.kind.kind === 'wallet' && fleetAddresses.includes(target.address);

  // Wallets whose trade settings stay until their group's action ends: every wallet of an
  // armed watcher's group, and the wallets of a running buy or sell (D-045, D-046).
  const runRows = buyView.rows;
  const locked = useMemo(() => {
    const out = new Set<number>();
    for (const g of statusGroups ?? []) {
      const members = groups.find((x) => x.id === g.id)?.wallets ?? [];
      for (const index of members) {
        if (g.watch?.armed === true || (g.buy !== null && runRows.has(index))) out.add(index);
      }
    }
    return out;
  }, [statusGroups, runRows, groups]);

  // --- Group changes (BUNNDLY-69): saved in the vault, then the file waits to be saved. ---
  const tableWallets = useMemo(
    () =>
      shownGroup === null
        ? info.wallets
        : info.wallets.filter((w) => shownGroup.wallets.includes(w.index)),
    [info.wallets, shownGroup],
  );
  const groupTabs = groups.map((g) => ({
    id: g.id,
    name: g.name,
    wallets: g.wallets,
    state: groupState(groupStatus(g.id)),
    lamports: groupLamports(g.wallets, balances.lamports),
  }));
  /** The selected wallets the tab shows: the ones "Move to group" moves. */
  const viewSelected = tableWallets.filter((w) => active[w.index] ?? true).map((w) => w.index);
  const changing = commandBusy || phase.kind === 'adding' || phase.kind === 'savingTable';
  const sourceBusy = [...new Set(viewSelected.map((i) => groupOf(groups, i)))].flatMap((id) => {
    const why = id === undefined ? null : busyBlock(id);
    return why === null ? [] : [why];
  });
  const moveBlocked = changing
    ? 'Wait for the current change to finish.'
    : viewSelected.length === 0
      ? 'Select the wallets to move.'
      : (sourceBusy[0] ?? null);
  const targetBlocked = new Map(
    groups.flatMap((g) => {
      const why =
        busyBlock(g.id) ??
        (viewSelected.every((i) => g.wallets.includes(i))
          ? 'The selected wallets are in this group already.'
          : null);
      return why === null ? [] : [[g.id, why] as const];
    }),
  );
  const firstGroup = groups[0];
  const deleteBlocked =
    shownGroup === null
      ? null
      : shownGroup.id === firstGroup?.id
        ? 'The first group takes the wallets of deleted groups: it cannot be deleted.'
        : (busyBlock(shownGroup.id) ?? (firstGroup ? busyBlock(firstGroup.id) : null));
  // In the trade saves' queue, so a group change and an amount entered just before it both stay.
  const saveGroups = (next: readonly WalletGroupV1[], note: string): Promise<boolean> => {
    setError(null);
    const run = async (): Promise<boolean> => {
      const current = latest.current;
      try {
        const result = await client.request({
          type: 'saveSettings',
          settings: {
            maxSpend: current.maxSpend,
            active: current.active,
            global: current.global,
            groups: next,
          },
        });
        latest.current = result.info.settings;
        setPhase({
          kind: 'unsaved',
          fileText: result.fileText,
          fleetName: result.info.fleetName,
          note,
          savedNote: 'with the new wallet groups',
          saving: false,
        });
        await refresh();
        return true;
      } catch (e) {
        setError(toUserMessage(e));
        return false;
      }
    };
    const result = queue.current.then(run, run);
    queue.current = result;
    return result;
  };
  const onMove = async (to: MoveTarget): Promise<boolean> => {
    if (moveBlocked !== null) return false;
    const name = 'name' in to ? to.name : (groups.find((g) => g.id === to.id)?.name ?? to.id);
    return saveGroups(
      moveWallets(groups, viewSelected, to),
      `${String(viewSelected.length)} wallets moved to ${name}; the groups are saved in the vault.`,
    );
  };
  const onRename = async (name: string): Promise<boolean> => {
    if (shownGroup === null || busyBlock(shownGroup.id) !== null) return false;
    return saveGroups(
      renameGroup(groups, shownGroup.id, name),
      `${shownGroup.name} is now ${name}; the groups are saved in the vault.`,
    );
  };
  const onDelete = async (): Promise<boolean> => {
    if (shownGroup === null || deleteBlocked !== null) return false;
    return saveGroups(
      deleteGroup(groups, shownGroup.id),
      `${shownGroup.name} is deleted and its wallets are in ${firstGroup?.name ?? 'the first group'}; the groups are saved in the vault.`,
    );
  };

  // Why "Create wallets" is off right now: the button's description and tooltip.
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
      const added = result.info.wallets.slice(-count);
      const first = added[0]?.label;
      const last = added.at(-1)?.label;
      if (first !== undefined && last !== undefined) say(`Created ${labelRange(first, last)}`);
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
      reportSaved(client, current.fileText);
      setPhase({ kind: 'saved', result, savedNote: current.savedNote });
    } catch (e) {
      setError(toUserMessage(e));
      setPhase({ ...current, saving: false });
    }
  };

  // --- Dashboard layout (BUNNDLY-73, mockup v2) ---
  const slots = useHeaderSlots();
  const { wake } = useWatchRuntime();
  const fleetLamports = groupLamports(
    info.wallets.map((w) => w.index),
    balances.lamports,
  );
  // The vault leaves the armed state when the run ends: show it without waiting for a poll.
  const runFinished = buyView.run?.phase === 'finished';
  useEffect(() => {
    if (runFinished) void refresh();
  }, [runFinished, refresh]);
  // Closing the tab stops the worker mid-buy: ask the browser to confirm.
  const anyRunning = groupRunning(undefined) || (status?.groups ?? []).some((g) => g.buy !== null);
  useEffect(() => {
    if (!anyRunning) return;
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [anyRunning]);
  // A buy started by a detection counts its times from the detection (SPEC 3.6).
  const fromDetection =
    viewRun !== null &&
    (status?.groups ?? []).some(
      (g) => g.watch?.detections.some((d) => d.runId === viewRun.runId) ?? false,
    );
  const modeBlocked = watchArmed
    ? WATCH_FROZEN
    : anyRunning
      ? 'A buy is running: change the mode when it ends.'
      : null;
  // Fleet fill (BUNNDLY-56): every selected wallet in the tone of its Fill, from `fillOf`
  // like the rows, counted by `fleetFill`.
  const fleetFills: Fill[] = selectedIndexes.map((i) => {
    const row = tableBuy?.get(i);
    if (row === undefined) return { percent: 0, tone: 'idle', label: 'Waiting' };
    return fillOf({
      state: row.state,
      reason: row.reason,
      verify: row.verify,
      dryRun: viewRun?.dryRun ?? global.dryRun,
      side: viewRun?.side ?? 'buy',
    });
  });
  const fleet = fleetFill(fleetFills);
  // Before the first run too: "0 of N filled" over N grey segments (BUNNDLY-93).
  const fill = {
    text: fleet.text,
    bar: <FleetSegments tones={fleetFills.map((f) => f.tone)} />,
  };

  return (
    <section className="screen dash" aria-labelledby={`${ids}-title`}>
      <h2 id={`${ids}-title`} className="sr-only">
        Fleet
      </h2>
      {slots.mode &&
        createPortal(
          <ModeSwitch
            dryRun={global.dryRun}
            network={global.network}
            readyCount={summary.readyCount}
            toSpend={summary.toSpendLamports}
            blocked={modeBlocked}
            onDryRun={setDryRun}
            onError={setError}
          />,
          slots.mode,
        )}
      {slots.balance &&
        createPortal(
          <button
            type="button"
            className="top-chip"
            title="Sum of all wallets. Click to read the balances again."
            aria-label={`Fleet balance: ${fleetLamports === null ? 'not read yet' : `${formatSol(fleetLamports)} SOL`}. Read again`}
            onClick={balances.refresh}
          >
            <SolIcon />
            <b className="num" data-testid="fleet-balance">
              {fleetLamports === null ? '—' : formatSol(fleetLamports)}
            </b>
            <span className="muted">fleet</span>
          </button>,
          slots.balance,
        )}
      {slots.say && said && createPortal(<span key={said.n}>{said.text}</span>, slots.say)}

      <CommandBar
        text={targetTexts[barKey] ?? ''}
        onText={onTargetText}
        watch={commandStatus?.watch ?? null}
        wakeUnavailable={wake === 'unavailable'}
        busy={commandBusy}
        reasons={reasons}
        blocked={buyBlocked}
        setup={hasRpc ? null : 'Add the Helius API key in Settings'}
        detected={detected}
        onCheck={onTargetCheck}
        onArm={onArm}
        onDisarm={onDisarm}
      >
        {mintError && (
          <p className="field-error" role="alert">
            {mintError}
          </p>
        )}
        {inFleet && (
          <p className="warn-line" role="status">
            This is a wallet from this fleet. Make sure you want to watch your own wallet.
          </p>
        )}
        {commandError && (
          <p className="field-error" role="alert">
            {commandError}
          </p>
        )}
        {anyRunning && (
          <p className="warn-line" role="status">
            A buy is running. Do not close or reload this tab until it ends: the keys and the buy
            live only in it.
          </p>
        )}
      </CommandBar>
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
                  const { group, wallets } = confirm;
                  const { stairs } = confirm;
                  if (confirm.kind === 'buy') launchBuy(confirm.mint, group.id, wallets, stairs);
                  else if (confirm.kind === 'sell') {
                    launchSell(confirm.mint, group.id, wallets, stairs);
                  } else launchArm(confirm.creator, group.id, wallets, stairs);
                }}
              >
                {CONFIRM_YES[confirm.kind]}
              </Button>
            </>
          }
        >
          <dl className="summary" aria-label="What the command does">
            <div>
              <dt>Group</dt>
              <dd>{confirm.group.name}</dd>
            </div>
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
                {confirm.stairs &&
                  `; Stairs: every ${String(confirm.stairs.intervalMs / 1_000)} s, ${String(confirm.stairs.perStep)} per step`}
              </dd>
            </div>
          </dl>
          <p>On-chain transactions cannot be undone.</p>
        </Modal>
      )}

      <FleetTable
        wallets={tableWallets}
        lamports={balances.lamports}
        feed={balances.feed}
        token={balances.token}
        maxSpend={savedMaxSpend}
        trade={info.settings.trade}
        locked={locked}
        selected={active}
        minReserve={minReserve}
        onTrade={onTrade}
        onSelect={onSelect}
        onSelectAll={onSelectAll}
        onCopy={onCopy}
        probe={rowProbe}
        buy={tableBuy}
        runDryRun={viewRun?.dryRun ?? global.dryRun}
        runSide={viewRun?.side ?? 'buy'}
        runPaused={viewRun?.paused ?? false}
        now={now}
        onBuyWallet={onBuyWallet}
        rowBuyBlocked={rowBlocked}
        onSellWallet={onSellWallet}
        rowSellBlocked={rowSellBlocked}
        frozen={frozen}
        groupNames={tab === null ? groupNames : undefined}
        explorer={global.explorer}
        network={global.network}
        above={
          // One group is the whole fleet: its tab would only repeat "All wallets" (BUNNDLY-73).
          groupTabs.length >= 2 ? (
            <GroupTabs
              groups={groupTabs}
              tab={tab}
              onTab={setTabChoice}
              allCount={info.wallets.length}
              allLamports={fleetLamports}
              renameBlocked={shownGroup ? busyBlock(shownGroup.id) : null}
              deleteBlocked={deleteBlocked}
              onRename={onRename}
              onDelete={onDelete}
            />
          ) : null
        }
        tools={
          <>
            <MoveToGroup
              groups={groupTabs}
              moveCount={viewSelected.length}
              moveBlocked={moveBlocked}
              targetBlocked={targetBlocked}
              onMove={onMove}
            />
            <CreateWallets room={room} limit={MAX_WALLETS} blocked={createBlocked} onCreate={add} />
            <EditSelected
              count={selectedCount}
              onSave={async (patch) => {
                const problem = await saveTrade(selectedIndexes, patch);
                if (problem === null)
                  say(`Settings saved for ${walletsText(selectedIndexes.length)}`);
                return problem;
              }}
            />
          </>
        }
        toolbar={
          <>
            <Segmented
              label="Execution mode"
              value={execMode}
              disabled={running}
              title={running ? MODE_LOCKED : undefined}
              options={[
                { value: 'immediate', label: 'Immediate', title: 'Every selected wallet at once' },
                { value: 'stairs', label: 'Stairs', title: 'The selected wallets in timed steps' },
              ]}
              onChange={setExecMode}
            />
            {execMode === 'stairs' && (
              <StairsStrip
                every={everyText}
                perStep={perStepText}
                onEvery={setEveryText}
                onPerStep={setPerStepText}
                plan={planText(
                  stairsPlan(
                    groupSelected.length,
                    parseEvery(everyText) ?? 1,
                    parsePerStep(perStepText) ?? 1,
                  ),
                )}
              />
            )}
            <span className="spacer" />
            {pause && (
              <Button
                icon={pause.label === 'Pause' ? <PauseIcon /> : <PlayIcon />}
                disabled={commandBusy}
                onClick={onPause}
              >
                {pause.label}
              </Button>
            )}
            <CommandButtons reasons={reasons} onBuy={onBuy} onSell={onSell} onStop={onStop} />
          </>
        }
      />
      <FleetSummaryBar
        summary={summary}
        walletCount={info.wallets.length}
        selectedCount={selectedCount}
        tokenDecimals={balances.token?.decimals ?? null}
        balancesRead={balances.lamports !== null}
        firstFillMs={buyView.run?.firstConfirmMs ?? null}
        lastFillMs={buyView.run?.lastConfirmMs ?? null}
        fillFrom={fromDetection ? 'detection' : 'start'}
        fill={fill}
      />

      <div className="dash-notes">
        {balances.source === 'fallback' && (
          <p className="warn-line">
            Helius is not responding. The balances come from the public Solana RPC and may be
            delayed.
          </p>
        )}
        {/* Without a Helius key the read cannot work: the target strip says what to do. */}
        {balances.error && hasRpc && (
          <p className="field-error" role="alert">
            {balances.error}
          </p>
        )}
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <SettingsResetNotice fields={info.settings.resetFields} />
        {(tableDirty || watchArmed) && (
          <div className="note-line">
            <Button
              size="sm"
              variant="primary"
              disabled={
                watchArmed || !tableDirty || (phase.kind !== 'idle' && phase.kind !== 'saved')
              }
              onClick={() => void saveTable()}
            >
              {phase.kind === 'savingTable' ? 'Saving…' : 'Save table changes'}
            </Button>
            {watchArmed ? (
              <span className="muted">{WATCH_FROZEN}</span>
            ) : (
              <span className="muted">You have unsaved table changes.</span>
            )}
          </div>
        )}
        {phase.kind === 'unsaved' && (
          <div className="note-line warn" role="status">
            <span>
              {phase.note} The updated fleet file is not saved yet.
              {!supportsDirectoryPicker(storage) &&
                ' Your browser will download the file. Then check the “Downloads” folder.'}
            </span>
            <Button
              size="sm"
              variant="primary"
              disabled={phase.saving}
              onClick={() => void save(phase)}
            >
              {phase.saving ? 'Saving…' : 'Save the updated fleet file'}
            </Button>
          </div>
        )}
        {phase.kind === 'saved' && (
          <p className="muted" role="status">
            Saved {phase.result.fileName} {phase.savedNote}.
          </p>
        )}
      </div>
    </section>
  );
}
