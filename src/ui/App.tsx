import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toUserMessage } from '../core/errors.ts';
import { DEFAULT_AUTO_LOCK_MS, type VaultStatus } from '../worker/protocol.ts';
import type { StorageEnv } from '../storage/keystore-file.ts';
import type { VaultClient } from '../worker/vault-client.ts';
import { AppHeader } from './AppHeader.tsx';
import { FleetScreen } from './screens/FleetScreen.tsx';
import { OpenScreen } from './screens/OpenScreen.tsx';
import { SettingsScreen } from './screens/SettingsScreen.tsx';
import { StartScreen } from './screens/StartScreen.tsx';
import { WizardScreen } from './screens/WizardScreen.tsx';
import { UNLOCKED_SCREENS, VaultContext, type Screen, type VaultState } from './vault-state.ts';

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
}

const DEFAULT_STATUS_POLL_MS = 5_000;
const DEFAULT_ACTIVITY_THROTTLE_MS = 30_000;
const ACTIVITY_EVENTS = ['pointerdown', 'keydown'] as const;
const UNSAVED_CONFIRM =
  'Plik floty nie został zapisany. Bez niego nie otworzysz floty w obecnym stanie. Kontynuować bez zapisu?';

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
}: AppProps) {
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [screen, setScreen] = useState<Screen>('start');
  const [notice, setNotice] = useState<string | null>(null);
  const wasUnlocked = useRef(false);
  const lastActivity = useRef(0);
  /** A keystore file not saved yet (new fleet or added wallets): never drop it silently. */
  const [unsavedFile, setUnsavedFile] = useState(false);

  const applyStatus = useCallback((next: VaultStatus, reason: 'auto' | 'user') => {
    setStatus(next);
    if (next.locked) {
      if (wasUnlocked.current) {
        // The wizard keeps its encrypted, not yet saved file; other screens go to Start.
        setScreen((s) => (UNLOCKED_SCREENS.has(s) ? 'start' : s));
        setNotice(
          reason === 'user'
            ? 'Flota została zablokowana.'
            : 'Flota została zablokowana automatycznie. Otwórz plik floty ponownie, aby kontynuować.',
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

  const lock = useCallback(async () => {
    // The wizard survives a lock with its file; added wallets on the fleet screen do not.
    if (unsavedFile && screen !== 'wizard' && !window.confirm(UNSAVED_CONFIRM)) return;
    try {
      applyStatus(await vault.request({ type: 'lock' }), 'user');
      // Drop the unsaved-file guard together with the status, not one render later when
      // the screen unmounts. The wizard keeps its encrypted file, so it stays guarded.
      if (screen !== 'wizard') setUnsavedFile(false);
    } catch (e) {
      setNotice(toUserMessage(e));
    }
  }, [vault, applyStatus, unsavedFile, screen]);

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
    if (!unsavedFile) return;
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [unsavedFile]);

  const context = useMemo<VaultState>(
    () => ({ client: vault, status, refresh }),
    [vault, status, refresh],
  );

  const unlocked = status !== null && !status.locked && status.info !== null;
  // Never render an unlocked-only screen without an unlocked fleet.
  const visible: Screen = UNLOCKED_SCREENS.has(screen) && !unlocked ? 'start' : screen;

  return (
    <VaultContext.Provider value={context}>
      <div className="app">
        <header className="app-header">
          <h1>Bunndly</h1>
          {status && (
            <AppHeader
              status={status}
              screen={visible}
              autoLockMinutes={
                status.info?.settings.global.autoLockMinutes ?? DEFAULT_AUTO_LOCK_MS / 60_000
              }
              onNavigate={navigate}
              onLock={() => void lock()}
            />
          )}
        </header>
        <main>
          {notice && (
            <p className="notice" role="alert">
              {notice}
            </p>
          )}
          {status === null ? (
            <p className="muted">Łączenie z sejfem…</p>
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
                  onUnsavedChange={setUnsavedFile}
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
                <FleetScreen
                  info={status.info}
                  storage={storage}
                  onUnsavedChange={setUnsavedFile}
                  {...(balanceRefreshMs === undefined ? {} : { balanceRefreshMs })}
                />
              )}
              {visible === 'settings' && status.info && (
                <SettingsScreen
                  info={status.info}
                  storage={storage}
                  onUnsavedChange={setUnsavedFile}
                />
              )}
            </>
          )}
        </main>
      </div>
    </VaultContext.Provider>
  );
}
