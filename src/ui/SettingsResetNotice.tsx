import type { SettingsField } from '../core/settings.ts';

const FIELD_LABELS: Record<SettingsField, string> = {
  minReserveLamports: 'minimalna rezerwa',
  maxAttempts: 'liczba prób',
  priceCeilingPercent: 'sufit ceny',
  noRouteWindowMs: 'okno „no route”',
  noRouteBackoffMinMs: 'początkowy odstęp ponowień',
  noRouteBackoffMaxMs: 'maksymalny odstęp ponowień',
  mode: 'tryb',
  explorer: 'explorer',
  autoLockMinutes: 'automatyczna blokada',
  jupiterPlan: 'plan Jupitera',
  orderRpm: 'limit /order',
};

/**
 * Settings from the file that were outside the current ranges and took the defaults
 * (D-019). Shown until the next save writes the defaults to the file.
 */
export function SettingsResetNotice({
  fields,
}: {
  readonly fields?: readonly SettingsField[] | undefined;
}) {
  if (!fields || fields.length === 0) return null;
  return (
    <p className="notice warning" role="status">
      Niektóre ustawienia z pliku floty były poza obecnym zakresem i przyjęły wartości domyślne:{' '}
      {fields.map((f) => FIELD_LABELS[f]).join(', ')}. Sprawdź je w Ustawieniach i zapisz, aby
      utrwalić zmianę w pliku.
    </p>
  );
}
