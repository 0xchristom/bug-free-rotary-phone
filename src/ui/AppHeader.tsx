import type { VaultStatus } from '../worker/protocol.ts';
import type { Screen } from './vault-state.ts';

export interface AppHeaderProps {
  readonly status: VaultStatus;
  readonly screen: Screen;
  readonly autoLockMinutes: number;
  readonly onNavigate: (screen: Screen) => void;
  readonly onLock: () => void;
}

const NAV: readonly { readonly screen: Screen; readonly label: string }[] = [
  { screen: 'fleet', label: 'Flota' },
  { screen: 'settings', label: 'Ustawienia' },
];

export function AppHeader({ status, screen, autoLockMinutes, onNavigate, onLock }: AppHeaderProps) {
  if (status.locked || status.info === null) return null;
  return (
    <div className="unlocked-bar">
      <span className="fleet-name" title="Nazwa floty">
        {status.info.fleetName}
      </span>
      <nav aria-label="Nawigacja">
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
      <span className="autolock" role="status">
        {status.armed
          ? 'Uzbrojono: automatyczna blokada wstrzymana'
          : `Automatyczna blokada po ${String(autoLockMinutes)} min bezczynności`}
      </span>
      <button type="button" className="danger" onClick={onLock}>
        Zablokuj
      </button>
    </div>
  );
}
