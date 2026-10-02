import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  AppError,
  DEFAULT_GLOBAL_SETTINGS,
  JUPITER_PLAN_RPM,
  JUPITER_RATE_LIMITS_URL,
  createKeystore,
  defaultFleetSettings,
  heliusRpcUrl,
  heliusWsUrl,
  isValidApiKeyValue,
  endpointUrlProblem,
  isHeliusHost,
  isValidEndpointUrl,
  orderRps,
  parseSecrets,
  secretsToJson,
  validateGlobalSettings,
  type GlobalSettingsV1,
  type KeystoreSecretsV1,
} from '../../src/core/index.ts';

function problems(patch: Partial<Record<keyof GlobalSettingsV1, unknown>>): string[] {
  return validateGlobalSettings({ ...DEFAULT_GLOBAL_SETTINGS, ...patch } as GlobalSettingsV1).map(
    (p) => `${p.field}: ${p.message}`,
  );
}

describe('Jupiter plans', () => {
  it('maps plans to the /order limits from the Jupiter docs (per minute)', () => {
    expect(JUPITER_PLAN_RPM).toEqual({
      keyless: 30,
      free: 60,
      developer: 600,
      launch: 3000,
      pro: 9000,
    });
    expect(Object.values(JUPITER_PLAN_RPM).map(orderRps)).toEqual([0.5, 1, 10, 50, 150]);
    expect(JUPITER_RATE_LIMITS_URL).toBe('https://developers.jup.ag/docs/portal/rate-limits.md');
  });

  it('the source file links the docs next to the table', () => {
    const source = readFileSync(new URL('../../src/core/settings.ts', import.meta.url), 'utf8');
    const table = source.indexOf('export const JUPITER_PLAN_RPM');
    const link = source.lastIndexOf(JUPITER_RATE_LIMITS_URL, table);
    expect(link).toBeGreaterThan(0);
    expect(table - link).toBeLessThan(300);
  });
});

describe('validateGlobalSettings', () => {
  it('accepts the defaults from SPEC 3.3', () => {
    expect(DEFAULT_GLOBAL_SETTINGS).toMatchObject({
      minReserveLamports: 15_000_000n,
      maxAttempts: 3,
      priceCeilingPercent: 50,
      noRouteWindowMs: 20_000,
      noRouteBackoffMinMs: 500,
      noRouteBackoffMaxMs: 2_000,
      mode: 'one-shot',
      autoLockMinutes: 15,
    });
    expect(validateGlobalSettings(DEFAULT_GLOBAL_SETTINGS)).toEqual([]);
  });

  it.each<[Partial<Record<keyof GlobalSettingsV1, unknown>>, string]>([
    [
      { priceCeilingPercent: 0 },
      'priceCeilingPercent: Sufit ceny musi być liczbą całkowitą od 1 do 1000%.',
    ],
    [
      { priceCeilingPercent: 1001 },
      'priceCeilingPercent: Sufit ceny musi być liczbą całkowitą od 1 do 1000%.',
    ],
    [{ maxAttempts: 0 }, 'maxAttempts: Liczba prób musi być liczbą całkowitą od 1 do 10.'],
    [{ maxAttempts: 11 }, 'maxAttempts: Liczba prób musi być liczbą całkowitą od 1 do 10.'],
    [{ maxAttempts: 2.5 }, 'maxAttempts: Liczba prób musi być liczbą całkowitą od 1 do 10.'],
    [
      { minReserveLamports: 999_999n },
      'minReserveLamports: Minimalna rezerwa musi wynosić od 0,001 do 1 SOL.',
    ],
    [
      { minReserveLamports: 1_000_000_001n },
      'minReserveLamports: Minimalna rezerwa musi wynosić od 0,001 do 1 SOL.',
    ],
    [
      { minReserveLamports: 15_000_000 },
      'minReserveLamports: Minimalna rezerwa musi wynosić od 0,001 do 1 SOL.',
    ],
    [{ noRouteWindowMs: 999 }, 'noRouteWindowMs: Okno „no route” musi wynosić od 1 do 120 s.'],
    [
      { noRouteBackoffMinMs: 50 },
      'noRouteBackoffMinMs: Początkowy odstęp ponowień musi wynosić od 100 do 10 000 ms.',
    ],
    [
      { noRouteBackoffMaxMs: 40_000 },
      'noRouteBackoffMaxMs: Maksymalny odstęp ponowień musi wynosić od 100 do 30 000 ms.',
    ],
    [
      { noRouteBackoffMinMs: 3_000, noRouteBackoffMaxMs: 2_000 },
      'noRouteBackoffMaxMs: Maksymalny odstęp ponowień nie może być krótszy niż początkowy.',
    ],
    [{ mode: 'forever' }, 'mode: Wybierz tryb: jednorazowy albo ciągły.'],
    [{ explorer: 'etherscan' }, 'explorer: Wybierz explorer z listy.'],
    [
      { autoLockMinutes: 0 },
      'autoLockMinutes: Automatyczna blokada musi wynosić od 1 do 120 minut.',
    ],
    [
      { autoLockMinutes: 121 },
      'autoLockMinutes: Automatyczna blokada musi wynosić od 1 do 120 minut.',
    ],
    [{ jupiterPlan: 'gold' }, 'jupiterPlan: Wybierz plan Jupitera z listy.'],
    [
      { jupiterPlan: 'pro', orderRpm: 60 },
      'orderRpm: Limit /order nie zgadza się z wybranym planem. Wybierz plan „Własny”.',
    ],
    [
      { jupiterPlan: 'custom', orderRpm: 0 },
      'orderRpm: Limit /order musi być liczbą całkowitą od 1 do 100 000 zapytań na minutę.',
    ],
  ])('%o → Polish message', (patch, message) => {
    expect(problems(patch)).toEqual([message]);
  });

  it('accepts the range edges and a custom limit', () => {
    expect(
      problems({
        priceCeilingPercent: 1000,
        maxAttempts: 10,
        minReserveLamports: 1_000_000n,
        autoLockMinutes: 120,
        noRouteBackoffMinMs: 2_000,
        noRouteBackoffMaxMs: 2_000,
        jupiterPlan: 'custom',
        orderRpm: 100_000,
      }),
    ).toEqual([]);
    expect(problems({ jupiterPlan: 'pro', orderRpm: 9000 })).toEqual([]);
  });
});

describe('Helius endpoints and API key values', () => {
  it('builds the documented mainnet URLs', () => {
    expect(heliusRpcUrl('abc-123')).toBe('https://mainnet.helius-rpc.com/?api-key=abc-123');
    expect(heliusWsUrl('abc-123')).toBe('wss://mainnet.helius-rpc.com/?api-key=abc-123');
    expect(heliusRpcUrl('a&b')).toBe('https://mainnet.helius-rpc.com/?api-key=a%26b');
  });

  it.each([
    ['https://mainnet.helius-rpc.com/?api-key=x', 'https:', true],
    ['https://staked.helius-rpc.com/?api-key=x', 'https:', true],
    ['https://helius-rpc.com/?api-key=x', 'https:', true],
    ['wss://mainnet.helius-rpc.com/?api-key=x', 'wss:', true],
    ['https://MAINNET.HELIUS-RPC.COM/', 'https:', true],
    ['http://mainnet.helius-rpc.com', 'https:', false],
    ['https://mainnet.helius-rpc.com', 'wss:', false],
    ['https://user:pw@mainnet.helius-rpc.com', 'https:', false],
    ['https://helius-rpc.com.evil.example/?api-key=x', 'https:', false],
    ['https://evilhelius-rpc.com/?api-key=x', 'https:', false],
    ['https://mainnet.helius-rpc.com./?api-key=x', 'https:', false],
    ['https://rpc.example.com/?api-key=x', 'https:', false],
    ['wss://api.mainnet.solana.com', 'wss:', false],
    ['not a url', 'https:', false],
    ['', 'https:', false],
  ] as const)('%s as %s → %s', (url, protocol, ok) => {
    expect(isValidEndpointUrl(url, protocol)).toBe(ok);
  });

  it.each([
    [
      'https://rpc.example.com/?api-key=x',
      'https:',
      'Dozwolone są tylko adresy Helius w domenie helius-rpc.com (np. https://mainnet.helius-rpc.com/?api-key=…).',
    ],
    [
      'wss://helius-rpc.com.evil.example',
      'wss:',
      'Dozwolone są tylko adresy Helius w domenie helius-rpc.com (np. wss://mainnet.helius-rpc.com/?api-key=…).',
    ],
    ['http://mainnet.helius-rpc.com', 'https:', 'Adres musi zaczynać się od https://.'],
    ['rpc', 'https:', 'To nie jest prawidłowy adres URL. Zacznij od https://.'],
    [
      'https://a:b@mainnet.helius-rpc.com',
      'https:',
      'Adres nie może zawierać nazwy użytkownika ani hasła.',
    ],
  ] as const)('endpointUrlProblem(%s, %s) explains in Polish', (url, protocol, message) => {
    expect(endpointUrlProblem(url, protocol)).toBe(message);
  });

  it('isHeliusHost accepts only the exact domain or its subdomains', () => {
    expect(isHeliusHost('helius-rpc.com')).toBe(true);
    expect(isHeliusHost('mainnet.helius-rpc.com.')).toBe(false); // CSP may not match it
    expect(isHeliusHost('helius-rpc.com.evil.example')).toBe(false);
    expect(isHeliusHost('evilhelius-rpc.com')).toBe(false);
    expect(isHeliusHost('helius-rpc.co')).toBe(false);
  });

  it('API keys: non-empty, at most 512 characters, no spaces or control characters', () => {
    expect(isValidApiKeyValue('helius', 'abc-123_XYZ')).toBe(true);
    expect(isValidApiKeyValue('jupiter', '')).toBe(false);
    expect(isValidApiKeyValue('jupiter', 'a b')).toBe(false);
    expect(isValidApiKeyValue('jupiter', 'a\nb')).toBe(false);
    expect(isValidApiKeyValue('helius', 'x'.repeat(513))).toBe(false);
    expect(isValidApiKeyValue('heliusRpcUrl', 'https://mainnet.helius-rpc.com')).toBe(true);
    expect(isValidApiKeyValue('heliusRpcUrl', 'https://rpc.example.com')).toBe(false);
    expect(isValidApiKeyValue('heliusWsUrl', 'https://mainnet.helius-rpc.com')).toBe(false);
  });
});

describe('settings in the keystore secrets', () => {
  let secrets: KeystoreSecretsV1;

  beforeAll(async () => {
    secrets = (
      await createKeystore({ fleetName: 'Ustawienia', walletCount: 3, password: 'x'.repeat(12) })
    ).secrets;
  });

  const json = (): Record<string, unknown> =>
    JSON.parse(secretsToJson(secrets)) as Record<string, unknown>;

  it('new fleets get the default settings', () => {
    expect(secrets.settings).toEqual(defaultFleetSettings());
  });

  it('round-trips global settings, active flags and all API secrets', () => {
    const full: KeystoreSecretsV1 = {
      ...secrets,
      settings: {
        maxSpend: [{ index: 1, lamports: 3n }],
        active: [{ index: 2, active: false }],
        global: {
          ...DEFAULT_GLOBAL_SETTINGS,
          minReserveLamports: 20_000_000n,
          mode: 'continuous',
          explorer: 'solana-explorer',
          jupiterPlan: 'launch',
          orderRpm: 3000,
        },
      },
      apiKeys: {
        helius: 'h',
        jupiter: 'j',
        heliusRpcUrl: 'https://mainnet.helius-rpc.com/?api-key=h',
        heliusWsUrl: 'wss://mainnet.helius-rpc.com/?api-key=h',
      },
    };
    const text = secretsToJson(full);
    expect(text).toContain('"minReserveLamports":"20000000"');
    expect(parseSecrets(JSON.parse(text))).toEqual(full);
  });

  it('settings without active/global (format before BUNNDLY-15) read as defaults', () => {
    const legacy = { ...json(), settings: { maxSpend: [{ index: 0, lamports: '5' }] } };
    expect(parseSecrets(legacy).settings).toEqual({
      maxSpend: [{ index: 0, lamports: 5n }],
      active: [],
      global: DEFAULT_GLOBAL_SETTINGS,
    });
  });

  it('a partial global object fills the missing fields with defaults', () => {
    const raw = { ...json(), settings: { maxSpend: [], global: { maxAttempts: 7 } } };
    expect(parseSecrets(raw).settings.global).toEqual({
      ...DEFAULT_GLOBAL_SETTINGS,
      maxAttempts: 7,
    });
  });

  it.each<[string, unknown]>([
    ['global out of range', { maxSpend: [], global: { maxAttempts: 99 } }],
    ['unknown global key', { maxSpend: [], global: { telemetry: true } }],
    ['reserve as number', { maxSpend: [], global: { minReserveLamports: 15000000 } }],
    ['active for a missing wallet', { maxSpend: [], active: [{ index: 7, active: true }] }],
    ['active not boolean', { maxSpend: [], active: [{ index: 0, active: 'yes' }] }],
    [
      'duplicate active',
      {
        maxSpend: [],
        active: [
          { index: 0, active: true },
          { index: 0, active: false },
        ],
      },
    ],
    ['unknown settings key', { maxSpend: [], extra: 1 }],
  ])('%s in the file → KEYSTORE_INVALID_FORMAT', (_label, settings) => {
    const caught = (() => {
      try {
        parseSecrets({ ...json(), settings });
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('KEYSTORE_INVALID_FORMAT');
  });

  it('a bad custom URL in the file → KEYSTORE_INVALID_FORMAT', () => {
    expect(() => parseSecrets({ ...json(), apiKeys: { heliusRpcUrl: 'http://x' } })).toThrow(
      AppError,
    );
  });
});
