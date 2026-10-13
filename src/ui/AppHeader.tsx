import type { ReactNode } from 'react';
import type { VaultStatus } from '../worker/protocol.ts';
import { Avatar, BrandMark, IconButton, LockIcon } from './kit/index.ts';
import type { Screen } from './vault-state.ts';

export interface AppHeaderProps {
  /** null until the vault answers for the first time. */
  readonly status: VaultStatus | null;
  readonly screen: Screen;
  readonly onNavigate: (screen: Screen) => void;
  readonly onLock: () => void;
  /** The network switch (it needs the app's unsaved-file state, so the app builds it). */
  readonly network: ReactNode;
}

const NAV: readonly { readonly screen: Screen; readonly label: string }[] = [
  { screen: 'fleet', label: 'Fleet' },
  { screen: 'settings', label: 'Settings' },
];

/** The top bar: brand, sections, run mode, network, the open fleet and its lock. */
export function AppHeader({ status, screen, onNavigate, onLock, network }: AppHeaderProps) {
  const info = status !== null && !status.locked ? status.info : null;
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
        {info && (
          <span
            className="top-chip"
            data-tone={info.settings.global.dryRun ? 'sim' : 'danger'}
            title={
              info.settings.global.dryRun
                ? 'DRY-RUN signs nothing and sends nothing'
                : 'Live mode: a buy sends real transactions'
            }
          >
            Mode: {info.settings.global.dryRun ? 'DRY-RUN' : 'LIVE'}
          </span>
        )}
        {network}
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
