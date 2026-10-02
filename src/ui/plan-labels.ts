import type { JupiterPlan } from '../core/settings.ts';

/** Jupiter plan names in the UI (Settings, buy summary). */
export const PLAN_LABELS: Record<JupiterPlan, string> = {
  keyless: 'Bez klucza (Keyless)',
  free: 'Free',
  developer: 'Developer',
  launch: 'Launch',
  pro: 'Pro',
  custom: 'Własny',
};
