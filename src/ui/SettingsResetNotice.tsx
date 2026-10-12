import type { SettingsField } from '../core/settings.ts';

const FIELD_LABELS: Record<SettingsField, string> = {
  minReserveLamports: 'minimum reserve',
  maxAttempts: 'attempts',
  priceCeilingPercent: 'price ceiling',
  noRouteWindowMs: '“no route” window',
  noRouteBackoffMinMs: 'first retry delay',
  noRouteBackoffMaxMs: 'longest retry delay',
  mode: 'mode',
  explorer: 'explorer',
  autoLockMinutes: 'auto-lock',
  dryRun: 'DRY-RUN mode',
  jupiterPlan: 'Jupiter plan',
  orderRpm: '/order limit',
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
      Some settings from the fleet file were outside the current range and took their default
      values: {fields.map((f) => FIELD_LABELS[f]).join(', ')}. Check them in Settings and save to
      keep the change in the file.
    </p>
  );
}
