/** Operations log and its CSV/JSON export (BUNNDLY-25, D-031). */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  LOG_COLUMNS,
  csvCell,
  formatPrice,
  logEntry,
  logFileName,
  toCsv,
  toJson,
  type ExecutorEvent,
  type LogContext,
  type WalletEvent,
} from '../../src/executor/index.ts';
import { parseExecution } from '../../src/jupiter/client.ts';
import type { WatchEvent } from '../../src/watcher/watch.ts';
import { T0 } from '../helpers/fake-clock.ts';

const docs = JSON.parse(readFileSync('tests/fixtures/jupiter-execute.docs.json', 'utf8')) as {
  success: unknown;
};

const context: LogContext = {
  addressOf: (i) => (i === 3 ? '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM' : null),
  decimals: 6,
};

function confirmed(): WalletEvent {
  const execution = parseExecution(docs.success);
  if (!execution) throw new Error('fixture');
  return {
    kind: 'wallet',
    runId: 2,
    at: T0,
    index: 3,
    state: 'CONFIRMED',
    attempt: 1,
    reason: null,
    quote: { inAmount: 10_000_000n, outAmount: 2_103n, router: 'metis' },
    result: {
      signature: execution.signature,
      slot: execution.slot,
      totalInputAmount: execution.totalInputAmount,
      totalOutputAmount: execution.totalOutputAmount,
    },
    times: { orderMs: 180, signMs: 4, executeMs: 1_900, sinceStartMs: 2_100 },
  };
}

describe('log entries', () => {
  it('/execute amounts from the docs fixture reach the entry exactly', () => {
    const entry = logEntry(confirmed(), context);
    expect(entry).toMatchObject({
      time: new Date(T0).toISOString(),
      event: 'wallet',
      state: 'CONFIRMED',
      wallet: 3,
      address: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
      spent: 10_000_000n,
      received: 2_101n,
      slot: 452_713_600n,
      router: 'metis',
      signature:
        'k3sza8ZDSPaKeAfH7HTMJv7rMzL2dgDy5D8bWRxo5t7T27eoUqwSVjLdZvBshTFrbdo7tERD99hY7cnW1WzXf8aX',
      // 0.01 SOL for 0.002101 tokens
      price: '4,759638267491',
      orderMs: 180,
    });
  });

  it('reasons carry their code, detail and Polish message', () => {
    const skipped: WalletEvent = {
      ...confirmed(),
      state: 'SKIPPED',
      result: null,
      reason: { kind: 'SKIPPED', code: 'PRICE_CEILING', detail: null },
    };
    expect(logEntry(skipped, context)).toMatchObject({
      reason: 'PRICE_CEILING',
      message: 'Cena powyżej sufitu względem pierwszego zakupu floty.',
      spent: null,
      price: null,
    });
    const run: ExecutorEvent = {
      kind: 'run',
      runId: 2,
      at: T0 + 5,
      phase: 'finished',
      mint: 'x',
      dryRun: false,
      wallets: 1,
      counts: {
        IDLE: 0,
        QUEUED: 0,
        QUOTING: 0,
        SIGNING: 0,
        SUBMITTED: 0,
        CONFIRMED: 1,
        FAILED: 0,
        UNKNOWN: 0,
        SKIPPED: 0,
      },
    };
    expect(logEntry(run, context)).toMatchObject({ event: 'run', state: 'finished', wallet: null });
    const verify: ExecutorEvent = {
      kind: 'verify',
      runId: 2,
      at: T0,
      index: 3,
      status: 'MISMATCH',
      expected: 2_101n,
      observed: 2_000n,
    };
    expect(logEntry(verify, context)).toMatchObject({
      event: 'verify',
      state: 'MISMATCH',
      expected: 2_101n,
      observed: 2_000n,
      message: 'Ostrzeżenie: saldo tokenu wzrosło o inną ilość, niż podał Jupiter.',
    });
  });
});

describe('effective price', () => {
  it('SOL per whole token, rounded down, decimal comma, no trailing zeros', () => {
    expect(formatPrice(1_000_000_000n, 1_000_000n, 6)).toBe('1');
    expect(formatPrice(10_000_000n, 1_180_000n, 6)).toBe('0,008474576271');
    expect(formatPrice(5n, 3n, 0)).toBe('0,000000001666');
    expect(formatPrice(1n, 0n, 6)).toBeNull();
    // u64 amounts do not overflow
    expect(formatPrice(2n ** 64n - 1n, 2n ** 64n - 1n, 9)).toBe('1');
  });
});

describe('CSV', () => {
  it('a cell a spreadsheet would run as a formula gets an apostrophe', () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-1000')).toBe("'-1000");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('\t=1')).toBe("'\t=1");
    expect(csvCell('safe')).toBe('safe');
  });

  it('quotes cells with commas, quotes or line breaks', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=HYPERLINK("x","y")')).toBe('"\'=HYPERLINK(""x"",""y"")"');
    expect(csvCell(null)).toBe('');
  });

  it('header plus one row per entry; a =1+1 label stays text; bigints whole', () => {
    const odd: WalletEvent = {
      ...confirmed(),
      quote: { inAmount: 2n ** 64n - 1n, outAmount: 1n, router: '=1+1' },
    };
    const csv = toCsv([logEntry(odd, context)]);
    const [header, row, end] = csv.split('\r\n');
    expect(header).toBe(LOG_COLUMNS.join(','));
    expect(end).toBe('');
    expect(row).toContain(",'=1+1,");
    expect(row).toContain(',18446744073709551615,');
    expect(row?.split(',')).toHaveLength(LOG_COLUMNS.length + 1); // the price has a comma
  });
});

describe('JSON', () => {
  it('bigints as decimal strings, nothing lost', () => {
    const odd: WalletEvent = {
      ...confirmed(),
      quote: { inAmount: 2n ** 64n - 1n, outAmount: 1n, router: 'metis' },
    };
    const parsed = JSON.parse(toJson([logEntry(odd, context)])) as Record<string, unknown>[];
    expect(parsed[0]?.quoteIn).toBe('18446744073709551615');
    expect(parsed[0]?.received).toBe('2101');
    expect(parsed[0]?.orderMs).toBe(180);
  });

  it('file name: run and UTC time, no characters file systems refuse', () => {
    expect(logFileName(4, T0, 'csv')).toBe('bunndly-log-4-2026-09-21T14-13-20-000Z.csv');
  });
});

describe('mode B entries (BUNNDLY-34)', () => {
  const MINT = 'HEhuwZjGd8Za7jgjzzpsXJssnP89DQm4oYHghRpnpump';
  const detection = {
    mint: MINT,
    source: 'pump.fun',
    path: 'log',
    signature: '5sig',
    detectedAt: T0,
    runId: 7,
    reactionMs: 4,
    verified: null,
    problem: null,
  } as const;
  const events: WatchEvent[] = [
    { kind: 'watch', at: T0, type: 'armed', creator: 'Creator1', mode: 'one-shot' },
    { kind: 'watch', at: T0, type: 'detection', detection },
    { kind: 'watch', at: T0, type: 'verified', mint: MINT, signature: '5sig', match: false },
    {
      kind: 'watch',
      at: T0,
      type: 'detection',
      detection: { ...detection, runId: null, reactionMs: null, problem: 'DISARMED' },
    },
    { kind: 'watch', at: T0, type: 'disarmed', reason: 'one-shot' },
  ];

  it('arm, detection with reactionMs, verification warning, disarm', () => {
    const entries = events.map((e) => logEntry(e, context));
    expect(entries.map((e) => [e.event, e.state])).toEqual([
      ['watch', 'armed'],
      ['watch', 'detection'],
      ['watch', 'verified'],
      ['watch', 'detection'],
      ['watch', 'disarmed'],
    ]);
    expect(entries[0]).toMatchObject({ runId: null, address: 'Creator1', detail: 'one-shot' });
    expect(entries[1]).toMatchObject({
      runId: 7,
      mint: MINT,
      source: 'pump.fun',
      path: 'log',
      signature: '5sig',
      reactionMs: 4,
      reason: null,
    });
    expect(entries[2]?.detail).toBe('mismatch');
    expect(entries[2]?.message).toMatch(/nie tworzy mintu/u);
    expect(entries[3]).toMatchObject({ reason: 'DISARMED', reactionMs: null });
    expect(entries[3]?.message).toMatch(/Rozbrojono/u);
    const csv = toCsv(entries).split('\r\n');
    expect(csv[0]).toBe(LOG_COLUMNS.join(','));
    expect(csv[2]).toContain(',4'); // reactionMs is the last column
  });
});
