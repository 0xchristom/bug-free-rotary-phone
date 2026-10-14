import type { ReactNode } from 'react';
import type { VaultStatus } from '../worker/protocol.ts';
import { Avatar, BrandMark, IconButton, LockIcon } from './kit/index.ts';
import { DRY_RUN_NOTE, LIVE_NOTE } from './mode-text.ts';
import type { Screen } from './vault-state.ts';

export interface AppHeaderProps {
  /** null until the vault answers for the first time. */
  readonly status: VaultStatus | null;
  readonly screen: Screen;
  readonly onNavigate: (screen: Screen) => void;
  readonly onLock: () => void;
  /** The network switch (it needs the app's unsaved-file state, so the app builds it). */
  readonly network: ReactNode;
  /** Where the Dashboard puts the DRY-RUN switch and the fleet balance (header-slots.ts). */
  readonly modeSlot: (element: HTMLElement | null) => void;
  readonly balanceSlot: (element: HTMLElement | null) => void;
}

const NAV: readonly { readonly screen: Screen; readonly label: string }[] = [
  { screen: 'fleet', label: 'Dashboard' },
  { screen: 'activity', label: 'Activity' },
  { screen: 'settings', label: 'Settings' },
];

/**
 * The top bar (mockup v2): brand, sections, then the run mode, the network, the fleet
 * balance, the open fleet and its lock.
 */
export function AppHeader({
  status,
  screen,
  onNavigate,
  onLock,
  network,
  modeSlot,
  balanceSlot,
}: AppHeaderProps) {
  const info = status !== null && !status.locked ? status.info : null;
  const dashboard = info !== null && screen === 'fleet';
  return (
    <header className="top">
      <h1 className="brand">
        <BrandMark />
        Bunndly
      </h1>
      {info && (
        <nav className="nav" aria-label="Navigation">
          {NAV.map((item) => (
            <button
              key={item.screen}
              type="button"
              aria-current={screen === item.screen ? 'page' : undefined}
              onClick={() => {
                onNavigate(item.screen);
              }}
            >
              {item.label}
            </button>
          ))}
        </nav>
      )}
      <div className="top-right">
        {info && !dashboard && (
          <span
            className="top-chip"
            data-tone={info.settings.global.dryRun ? 'sim' : 'danger'}
            title={info.settings.global.dryRun ? DRY_RUN_NOTE : LIVE_NOTE}
          >
            Mode: {info.settings.global.dryRun ? 'DRY-RUN' : 'LIVE'}
          </span>
        )}
        {dashboard && <span className="top-slot" ref={modeSlot} />}
        {network}
        {dashboard && <span className="top-slot" ref={balanceSlot} />}
        {info && (
          <>
            <span className="top-chip" title="Fleet name">
              <Avatar seed={info.fleetName} size="sm" />
              {info.fleetName}
            </span>
            <IconButton label="Lock" variant="ghost" icon={<LockIcon />} onClick={onLock} />
          </>
        )}
      </div>
    </header>
  );
}
