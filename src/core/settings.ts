/**
 * Fleet settings (SPEC 3.3): types, defaults, the Jupiter plan → rate limit table and
 * range validation with Polish messages. Dependency-free, so the UI can validate the
 * form with exactly the rules the vault worker applies before saving (DECISIONS D-019).
 */

/** 1 SOL in lamports. */
export const LAMPORTS_PER_SOL = 1_000_000_000n;

/**
 * Jupiter API plans and their `/order` limit in requests per minute. The limit is a
 * sliding 60 s window shared by the whole organization (not per key); `/swap/v2/execute`
 * has a separate pool. Source: https://developers.jup.ag/docs/portal/rate-limits.md
 */
export const JUPITER_PLAN_RPM = {
  keyless: 30, // 0.5 RPS
  free: 60, // 1 RPS
  developer: 600, // 10 RPS
  launch: 3000, // 50 RPS
  pro: 9000, // 150 RPS
} as const satisfies Record<string, number>;

export const JUPITER_RATE_LIMITS_URL = 'https://developers.jup.ag/docs/portal/rate-limits.md';

export type JupiterNamedPlan = keyof typeof JUPITER_PLAN_RPM;
/** `custom`: the limit is typed in by the user. */
export type JupiterPlan = JupiterNamedPlan | 'custom';
export const JUPITER_PLANS: readonly JupiterPlan[] = [
  'keyless',
  'free',
  'developer',
  'launch',
  'pro',
  'custom',
];

export const EXPLORERS = ['solscan', 'orb', 'solana-explorer'] as const;
export type Explorer = (typeof EXPLORERS)[number];

export const BUY_MODES = ['one-shot', 'continuous'] as const;
/** one-shot (default): the watcher disarms after the first detected token. */
export type BuyMode = (typeof BUY_MODES)[number];

/** Settings for the whole fleet (SPEC 3.3). Stored inside the encrypted keystore. */
export interface GlobalSettingsV1 {
  /** MIN_RESERVE_SOL in lamports. */
  readonly minReserveLamports: bigint;
  /** Max buy attempts per wallet. */
  readonly maxAttempts: number;
  /** Max deviation of a wallet's price from the fleet's first fill, in percent. */
  readonly priceCeilingPercent: number;
  /** How long "no route" is retried for a fresh token. */
  readonly noRouteWindowMs: number;
  readonly noRouteBackoffMinMs: number;
  readonly noRouteBackoffMaxMs: number;
  readonly mode: BuyMode;
  readonly explorer: Explorer;
  readonly autoLockMinutes: number;
  readonly jupiterPlan: JupiterPlan;
  /** Jupiter `/order` limit per minute; ORDER_RPS = orderRpm / 60. */
  readonly orderRpm: number;
}

export const DEFAULT_GLOBAL_SETTINGS: GlobalSettingsV1 = {
  minReserveLamports: 15_000_000n, // 0.015 SOL
  maxAttempts: 3,
  priceCeilingPercent: 50,
  noRouteWindowMs: 20_000,
  noRouteBackoffMinMs: 500,
  noRouteBackoffMaxMs: 2_000,
  mode: 'one-shot',
  explorer: 'solscan',
  autoLockMinutes: 15,
  jupiterPlan: 'free',
  orderRpm: JUPITER_PLAN_RPM.free,
};

/** Inclusive ranges of the numeric settings. */
export const SETTINGS_LIMITS = {
  // 0.005–1 SOL: the reserve pays the token account rent (≈ 0.00204 SOL for SPL, more for
  // Token-2022 with extensions), priority fees and the later sale (BUNNDLY-15 review).
  minReserveLamports: { min: 5_000_000n, max: LAMPORTS_PER_SOL },
  maxAttempts: { min: 1, max: 10 },
  priceCeilingPercent: { min: 1, max: 1000 },
  noRouteWindowMs: { min: 1_000, max: 120_000 },
  noRouteBackoffMinMs: { min: 100, max: 10_000 },
  noRouteBackoffMaxMs: { min: 100, max: 30_000 },
  autoLockMinutes: { min: 1, max: 120 },
  orderRpm: { min: 1, max: 100_000 },
} as const;

export type SettingsField = keyof GlobalSettingsV1;

export interface SettingsProblem {
  readonly field: SettingsField;
  /** Polish message for the form. Never contains the entered value. */
  readonly message: string;
}

/** Requests per second allowed on Jupiter `/order` for a per-minute limit. */
export function orderRps(orderRpm: number): number {
  return orderRpm / 60;
}

function isIntIn(value: unknown, range: { min: number; max: number }): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= range.min &&
    value <= range.max
  );
}

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

/**
 * Checks ranges and relations of the global settings. Returns an empty list when the
 * settings are valid; the worker refuses to save anything else (INVALID_SETTINGS).
 */
export function validateGlobalSettings(g: GlobalSettingsV1): SettingsProblem[] {
  const problems: SettingsProblem[] = [];
  const L = SETTINGS_LIMITS;
  const add = (field: SettingsField, message: string): void => {
    problems.push({ field, message });
  };

  if (
    typeof g.minReserveLamports !== 'bigint' ||
    g.minReserveLamports < L.minReserveLamports.min ||
    g.minReserveLamports > L.minReserveLamports.max
  ) {
    add('minReserveLamports', 'Minimalna rezerwa musi wynosić od 0,005 do 1 SOL.');
  }
  if (!isIntIn(g.maxAttempts, L.maxAttempts)) {
    add('maxAttempts', 'Liczba prób musi być liczbą całkowitą od 1 do 10.');
  }
  if (!isIntIn(g.priceCeilingPercent, L.priceCeilingPercent)) {
    add('priceCeilingPercent', 'Sufit ceny musi być liczbą całkowitą od 1 do 1000%.');
  }
  if (!isIntIn(g.noRouteWindowMs, L.noRouteWindowMs)) {
    add('noRouteWindowMs', 'Okno „no route” musi wynosić od 1 do 120 s.');
  }
  const minOk = isIntIn(g.noRouteBackoffMinMs, L.noRouteBackoffMinMs);
  const maxOk = isIntIn(g.noRouteBackoffMaxMs, L.noRouteBackoffMaxMs);
  if (!minOk) {
    add('noRouteBackoffMinMs', 'Początkowy odstęp ponowień musi wynosić od 100 do 10 000 ms.');
  }
  if (!maxOk) {
    add('noRouteBackoffMaxMs', 'Maksymalny odstęp ponowień musi wynosić od 100 do 30 000 ms.');
  } else if (minOk && g.noRouteBackoffMaxMs < g.noRouteBackoffMinMs) {
    add('noRouteBackoffMaxMs', 'Maksymalny odstęp ponowień nie może być krótszy niż początkowy.');
  }
  if (!oneOf(BUY_MODES, g.mode)) add('mode', 'Wybierz tryb: jednorazowy albo ciągły.');
  if (!oneOf(EXPLORERS, g.explorer)) add('explorer', 'Wybierz explorer z listy.');
  if (!isIntIn(g.autoLockMinutes, L.autoLockMinutes)) {
    add('autoLockMinutes', 'Automatyczna blokada musi wynosić od 1 do 120 minut.');
  }
  if (!oneOf(JUPITER_PLANS, g.jupiterPlan)) {
    add('jupiterPlan', 'Wybierz plan Jupitera z listy.');
  } else if (g.jupiterPlan === 'custom') {
    if (!isIntIn(g.orderRpm, L.orderRpm)) {
      add('orderRpm', 'Limit /order musi być liczbą całkowitą od 1 do 100 000 zapytań na minutę.');
    }
  } else if (g.orderRpm !== JUPITER_PLAN_RPM[g.jupiterPlan]) {
    add('orderRpm', 'Limit /order nie zgadza się z wybranym planem. Wybierz plan „Własny”.');
  }
  return problems;
}

// --- Helius endpoints -------------------------------------------------------------

/** Per Helius docs: the key goes in the `api-key` query parameter. */
export function heliusRpcUrl(apiKey: string): string {
  return `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`;
}

export function heliusWsUrl(apiKey: string): string {
  return `wss://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`;
}

/**
 * The only domain allowed for custom Helius endpoints: the CSP (SPEC 6.4) lets the app
 * connect only to Helius, api.jup.ag and the fallback RPC, so any other host would fail
 * silently in the production build.
 */
export const HELIUS_DOMAIN = 'helius-rpc.com';

/**
 * Exactly helius-rpc.com or a subdomain of it (not helius-rpc.com.evil.example). A
 * trailing dot (`mainnet.helius-rpc.com.`) is refused: the CSP may not match it.
 */
export function isHeliusHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === HELIUS_DOMAIN || host.endsWith(`.${HELIUS_DOMAIN}`);
}

/**
 * Why a custom endpoint is not accepted, as a Polish message, or null if it is fine:
 * `https:` for RPC or `wss:` for WebSocket, a Helius host, no user/password in the URL.
 */
export function endpointUrlProblem(value: string, protocol: 'https:' | 'wss:'): string | null {
  const scheme = protocol === 'https:' ? 'https://' : 'wss://';
  if (value.length === 0 || value.length > 512) {
    return 'Adres musi mieć od 1 do 512 znaków.';
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `To nie jest prawidłowy adres URL. Zacznij od ${scheme}.`;
  }
  if (url.protocol !== protocol) return `Adres musi zaczynać się od ${scheme}.`;
  if (url.username || url.password) return 'Adres nie może zawierać nazwy użytkownika ani hasła.';
  if (!isHeliusHost(url.hostname)) {
    return `Dozwolone są tylko adresy Helius w domenie ${HELIUS_DOMAIN} (np. ${scheme}mainnet.${HELIUS_DOMAIN}/?api-key=…).`;
  }
  return null;
}

/** Custom endpoint check used by the keystore parser and the worker. */
export function isValidEndpointUrl(value: string, protocol: 'https:' | 'wss:'): boolean {
  return endpointUrlProblem(value, protocol) === null;
}
