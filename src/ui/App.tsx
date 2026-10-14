import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toUserMessage } from '../core/errors.ts';
import type { VaultStatus } from '../worker/protocol.ts';
import type { StorageEnv } from '../storage/keystore-file.ts';
import type { VaultClient } from '../worker/vault-client.ts';
import { DEFAULT_NETWORK, type Network } from '../core/network.ts';
import { AppHeader } from './AppHeader.tsx';
import { ExportDialog } from './ExportDialog.tsx';
import { HeaderSlotsContext, type HeaderSlots } from './header-slots.ts';
import { NetworkNotice, NetworkSwitch } from './NetworkSwitch.tsx';
import type { FeedState } from '../chain/balance-stream.ts';
import { BalanceFeedContext, RpcReadContext, type RpcRead } from './shell-status.ts';
import { ToastProvider } from './kit/index.ts';
import { StatusBar } from './StatusBar.tsx';
import { useNetworkSwitch } from './use-network-switch.ts';
import { createOperationsLog } from './operations-log.ts';
import { useBuyView } from './use-buy.ts';
import { ActivityScreen } from './screens/ActivityScreen.tsx';
import { FleetScreen } from './screens/FleetScreen.tsx';
import { OpenScreen } from './screens/OpenScreen.tsx';
import { SettingsScreen } from './screens/SettingsScreen.tsx';
import { StartScreen } from './screens/StartScreen.tsx';
import { WizardScreen } from './screens/WizardScreen.tsx';
import { APP_VERSION } from './version.ts';
import { UNLOCKED_SCREENS, VaultContext, type Screen, type VaultState } from './vault-state.ts';
import { WatchGuard } from './WatchGuard.tsx';
import {
  ALARM_REPEAT_MS,
  AlarmSound,
  WatchRuntimeContext,
  browserWatchApis,
  useWakeLock,
  type WatchBrowser,
  type WatchRuntime,
} from './watch-runtime.ts';

export interface AppProps {
  readonly vault: VaultClient;
  /** Where the keystore file is saved (File System Access API or download). */
  readonly storage: StorageEnv;
  /** How often the UI re-reads the vault status (to notice auto-lock). */
  readonly statusPollMs?: number;
  /** Minimum gap between `activity` reports to the vault. */
  readonly activityThrottleMs?: number;
  /** SOL balance refresh interval on the fleet screen (SPEC 3.2: 10–15 s). */
  readonly balanceRefreshMs?: number;
  /** Test hook: called on each fleet table row render. */
  readonly rowProbe?: (index: number) => void;
  /** Web Audio and Wake Lock for mode B; the browser's own by default (tests pass mocks). */
  readonly watchBrowser?: WatchBrowser;
  /** How often the alarm tone repeats (tests use a short one). */
  readonly alarmRepeatMs?: number;
}

const DEFAULT_STATUS_POLL_MS = 5_000;
const DEFAULT_ACTIVITY_THROTTLE_MS = 30_000;
const ACTIVITY_EVENTS = ['pointerdown', 'keydown'] as const;
const UNSAVED_CONFIRM =
  'The fleet file is not saved. Without it you cannot open the fleet in its current state. Continue without saving?';

/**
 * App shell: screen switching in React state (no router, nothing in the URL), the vault
 * status, the lock button and auto-lock handling. Screens are filled in by later tasks.
 */
export function App({
  vault,
  storage,
  statusPollMs = DEFAULT_STATUS_POLL_MS,
  activityThrottleMs = DEFAULT_ACTIVITY_THROTTLE_MS,
  balanceRefreshMs,
  rowProbe,
  watchBrowser,
  alarmRepeatMs = ALARM_REPEAT_MS,
}: AppProps) {
  const [browser] = useState(() => watchBrowser ?? browserWatchApis());
  const [alarm] = useState(() => new AlarmSound(browser.createAudioContext));
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [screen, setScreen] = useState<Screen>('start');
  const [notice, setNotice] = useState<string | null>(null);
  const wasUnlocked = useRef(false);
  const lastActivity = useRef(0);
  /** A keystore file not saved yet (new fleet or added wallets): never drop it silently. */
  const [unsavedFile, setUnsavedFile] = useState(false);
  // One log per session, outside React state: it survives screens and the auto-lock.
  const [operationsLog] = useState(() => createOperationsLog(vault));
  // Buy progress outlives screen changes (e.g. a look at Settings during a buy).
  const buyView = useBuyView(vault);
  const [mintDecimals, setMintDecimals] = useState<ReadonlyMap<string, number>>(new Map());
  // The Dashboard's parts of the top bar (header-slots.ts).
  const [modeSlot, setModeSlot] = useState<HTMLElement | null>(null);
  const [balanceSlot, setBalanceSlot] = useState<HTMLElement | null>(null);
  const slots = useMemo<HeaderSlots>(
    () => ({ mode: modeSlot, balance: balanceSlot }),
    [modeSlot, balanceSlot],
  );
  const [exportOpen, setExportOpen] = useState(false);
  const onMintDecimals = useCallback((mint: string, decimals: number) => {
    setMintDecimals((m) => (m.get(mint) === decimals ? m : new Map(m).set(mint, decimals)));
  }, []);
  const wallets = status?.info?.wallets;
  useEffect(() => {
    if (wallets) operationsLog.setWallets(wallets);
  }, [operationsLog, wallets]);
  const network = status?.network ?? DEFAULT_NETWORK;
  useEffect(() => {
    operationsLog.setNetwork(network);
  }, [operationsLog, network]);

  // The status rail shows the last balance read of the network on screen, never an older one.
  const [lastRead, setLastRead] = useState<(RpcRead & { readonly network: Network }) | null>(null);
  const reportRead = useCallback(
    (read: RpcRead) => {
      setLastRead({ ...read, network });
    },
    [network],
  );

  // Live or polling balances (BUNNDLY-57), of the network on screen only.
  const [feed, setFeed] = useState<{ readonly state: FeedState; readonly network: Network } | null>(
    null,
  );
  const reportFeed = useCallback(
    (state: FeedState | null) => {
      setFeed(state === null ? null : { state, network });
    },
    [network],
  );

  const applyStatus = useCallback((next: VaultStatus, reason: 'auto' | 'user') => {
    setStatus(next);
    if (next.locked) {
      // The next fleet may hold another RPC key: its rail starts from "no read yet".
      setLastRead(null);
      if (wasUnlocked.current) {
        // The wizard keeps its encrypted, not yet saved file; other screens go to Start.
        setScreen((s) => (UNLOCKED_SCREENS.has(s) ? 'start' : s));
        setNotice(
          reason === 'user'
            ? 'The fleet was locked.'
            : 'The fleet was locked automatically. Open the fleet file again to continue.',
        );
      }
      wasUnlocked.current = false;
    } else {
      // Opening a fleet from Start shows it; the wizard stays until its file is saved.
      if (!wasUnlocked.current) setScreen((s) => (s === 'start' ? 'fleet' : s));
      wasUnlocked.current = true;
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      applyStatus(await vault.request({ type: 'status' }), 'auto');
    } catch (e) {
      setNotice(toUserMessage(e));
    }
  }, [vault, applyStatus]);

  // Subscribes to the vault status; auto-lock in the worker shows up here.
  useEffect(() => {
    let active = true;
    const poll = (): void => {
      vault.request({ type: 'status' }).then(
        (next) => {
          if (active) applyStatus(next, 'auto');
        },
        (e: unknown) => {
          if (active) setNotice(toUserMessage(e));
        },
      );
    };
    poll();
    const timer = setInterval(poll, statusPollMs);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [vault, applyStatus, statusPollMs]);

  // A fleet remembered on this device opens without the password while its window lasts
  // (BUNNDLY-52). Start waits for the answer so it does not flash before the fleet.
  const [resumed, setResumed] = useState(false);
  useEffect(() => {
    let active = true;
    vault
      .request({ type: 'resume' })
      .then(
        (next) => {
          if (active) applyStatus(next, 'auto');
        },
        () => undefined,
      )
      .finally(() => {
        if (active) setResumed(true);
      });
    return () => {
      active = false;
    };
  }, [vault, applyStatus]);

  // User activity keeps the vault unlocked; reported at most once per throttle window.
  useEffect(() => {
    const onActivity = (): void => {
      if (!wasUnlocked.current) return;
      const now = Date.now();
      if (now - lastActivity.current < activityThrottleMs) return;
      lastActivity.current = now;
      vault.request({ type: 'activity' }).catch(() => undefined);
    };
    for (const type of ACTIVITY_EVENTS) window.addEventListener(type, onActivity);
    return () => {
      for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, onActivity);
    };
  }, [vault, activityThrottleMs]);

  const switching = useNetworkSwitch(vault, status, unsavedFile, storage, refresh);
  const networkUnsaved = switching.unsaved;
  const dropNetworkFile = switching.drop;
  // A screen with an unsaved fleet file holds a newer one, which has the network too.
  const onScreenUnsaved = useCallback(
    (unsaved: boolean) => {
      setUnsavedFile(unsaved);
      if (unsaved) dropNetworkFile();
    },
    [dropNetworkFile],
  );

  const lock = useCallback(async () => {
    // The wizard survives a lock with its file; added wallets on the fleet screen do not.
    if (
      ((unsavedFile && screen !== 'wizard') || networkUnsaved) &&
      !window.confirm(UNSAVED_CONFIRM)
    ) {
      return;
    }
    try {
      applyStatus(await vault.request({ type: 'lock' }), 'user');
      dropNetworkFile();
      // Drop the unsaved-file guard together with the status, not one render later when
      // the screen unmounts. The wizard keeps its encrypted file, so it stays guarded.
      if (screen !== 'wizard') setUnsavedFile(false);
    } catch (e) {
      setNotice(toUserMessage(e));
    }
  }, [vault, applyStatus, unsavedFile, screen, networkUnsaved, dropNetworkFile]);

  const navigate = useCallback(
    (next: Screen) => {
      if (unsavedFile && !window.confirm(UNSAVED_CONFIRM)) {
        return;
      }
      setUnsavedFile(false);
      setNotice(null);
      setScreen(next);
    },
    [unsavedFile],
  );

  // Closing the tab with an unsaved fleet file asks the browser to confirm.
  useEffect(() => {
    if (!unsavedFile && !networkUnsaved) return;
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [unsavedFile, networkUnsaved]);

  const context = useMemo<VaultState>(
    () => ({ client: vault, status, refresh }),
    [vault, status, refresh],
  );
  // The screen stays on while the watcher is armed (SPEC 3.4).
  const wake = useWakeLock(status?.watch?.armed ?? false, browser.wakeLock);
  const watchRuntime = useMemo<WatchRuntime>(
    () => ({ alarm, wake, alarmRepeatMs }),
    [alarm, wake, alarmRepeatMs],
  );

  const unlocked = status !== null && !status.locked && status.info !== null;
  // Never render an unlocked-only screen without an unlocked fleet.
  const visible: Screen = UNLOCKED_SCREENS.has(screen) && !unlocked ? 'start' : screen;

  return (
    <VaultContext.Provider value={context}>
      <WatchRuntimeContext.Provider value={watchRuntime}>
        <RpcReadContext.Provider value={reportRead}>
          <BalanceFeedContext.Provider value={reportFeed}>
            <ToastProvider>
              <div className="app">
                <AppHeader
                  status={status}
                  screen={visible}
                  onNavigate={navigate}
                  onLock={() => void lock()}
                  modeSlot={setModeSlot}
                  balanceSlot={setBalanceSlot}
                  network={
                    status && (
                      <NetworkSwitch
                        network={network}
                        locked={status.locked || status.info === null}
                        onChoose={switching.choose}
                      />
                    )
                  }
                />
                <main className={visible === 'fleet' ? 'content dash-content' : 'content'}>
                  {unlocked && <WatchGuard />}
                  {unlocked && <NetworkNotice switching={switching} storage={storage} />}
                  {notice && (
                    <p className="notice" role="alert">
                      {notice}
                    </p>
                  )}
                  {status === null || !resumed ? (
                    <p className="muted">Connecting to the vault…</p>
                  ) : (
                    <>
                      {visible === 'start' && (
                        <StartScreen
                          onCreate={() => {
                            navigate('wizard');
                          }}
                          onOpen={() => {
                            navigate('open');
                          }}
                        />
                      )}
                      {visible === 'wizard' && (
                        <WizardScreen
                          storage={storage}
                          onBack={() => {
                            navigate(unlocked ? 'fleet' : 'start');
                          }}
                          onDone={() => {
                            navigate('fleet');
                          }}
                          onUnsavedChange={onScreenUnsaved}
                        />
                      )}
                      {visible === 'open' && (
                        <OpenScreen
                          storage={storage}
                          onBack={() => {
                            navigate('start');
                          }}
                          onUnlocked={() => {
                            navigate('fleet');
                          }}
                        />
                      )}
                      {visible === 'fleet' && status.info && (
                        <HeaderSlotsContext.Provider value={slots}>
                          <FleetScreen
                            info={status.info}
                            storage={storage}
                            onUnsavedChange={onScreenUnsaved}
                            buyView={buyView}
                            onMintDecimals={onMintDecimals}
                            {...(balanceRefreshMs === undefined ? {} : { balanceRefreshMs })}
                            {...(rowProbe === undefined ? {} : { rowProbe })}
                          />
                        </HeaderSlotsContext.Provider>
                      )}
                      {visible === 'activity' && status.info && (
                        <ActivityScreen
                          info={status.info}
                          storage={storage}
                          operationsLog={operationsLog}
                          decimals={
                            buyView.run === null
                              ? null
                              : (mintDecimals.get(buyView.run.mint) ?? null)
                          }
                        />
                      )}
                      {visible === 'settings' && status.info && (
                        <SettingsScreen
                          info={status.info}
                          storage={storage}
                          onUnsavedChange={onScreenUnsaved}
                        />
                      )}
                    </>
                  )}
                </main>
                <StatusBar
                  version={APP_VERSION}
                  status={status}
                  read={unlocked && lastRead?.network === network ? lastRead : null}
                  feed={unlocked && feed?.network === network ? feed.state : null}
                  autoLockMinutes={status?.info?.settings.global.autoLockMinutes ?? null}
                  onExport={
                    unlocked
                      ? () => {
                          setExportOpen(true);
                        }
                      : null
                  }
                />
                {exportOpen && unlocked && (
                  <ExportDialog
                    storage={storage}
                    onClose={() => {
                      setExportOpen(false);
                    }}
                  />
                )}
              </div>
            </ToastProvider>
          </BalanceFeedContext.Provider>
        </RpcReadContext.Provider>
      </WatchRuntimeContext.Provider>
    </VaultContext.Provider>
  );
}
