/**
 * Mint detectors (BUNNDLY-33, D-037) on real mainnet data: transactions per launchpad,
 * the generic fallback, real pump.fun `logsNotification` messages and negative cases.
 * The expected mint in the fixtures is independent of the detectors (the mint that
 * appears in `postTokenBalances` and not in `preTokenBalances`).
 */
import { readFileSync } from 'node:fs';
import { base64 } from '@scure/base';
import { describe, expect, it } from 'vitest';
import {
  createDetector,
  type DetectorEvent,
  type SignatureInput,
} from '../../src/watcher/detectors/detector.ts';
import { detectFromLogs, programData } from '../../src/watcher/detectors/log-path.ts';
import {
  METEORA_DBC_PROGRAM,
  PUMP_FUN_PROGRAM,
  RAYDIUM_LAUNCHLAB_PROGRAM,
} from '../../src/watcher/detectors/programs.ts';
import {
  asTransaction,
  detectFromTransaction,
} from '../../src/watcher/detectors/transaction-path.ts';
import { FakeClock, T0 } from '../helpers/fake-clock.ts';

interface FixtureTx {
  readonly signature: string;
  readonly kind: string;
  readonly watched: string;
  readonly watchedIsSigner: boolean;
  readonly expectedMint: string | null;
  readonly expectedSource: string | null;
  readonly tx: unknown;
}

interface FixtureNotification {
  readonly watched: string;
  readonly expectedMint: string;
  readonly message: {
    readonly params: {
      readonly result: { readonly value: { readonly signature: string; readonly logs: string[] } };
    };
  };
  readonly tx: unknown;
}

const F = JSON.parse(readFileSync('tests/fixtures/detectors.mainnet.json', 'utf8')) as {
  readonly transactions: Record<string, FixtureTx>;
  readonly notifications: readonly FixtureNotification[];
};

const txOf = (f: FixtureTx | FixtureNotification) => {
  const tx = asTransaction(f.tx);
  if (!tx) throw new Error('fixture is not a transaction');
  return tx;
};

const positives = Object.entries(F.transactions).filter(([, f]) => f.expectedMint !== null);
const negatives = Object.entries(F.transactions).filter(([, f]) => f.expectedMint === null);

describe('fixtures', () => {
  it('cover every launchpad and the fallback twice, plus the negative cases', () => {
    const sources = positives.map(([, f]) => f.expectedSource);
    for (const s of ['pump.fun', 'meteora-dbc', 'raydium-launchlab', 'initialize-mint']) {
      expect(sources.filter((x) => x === s).length, s).toBeGreaterThanOrEqual(2);
    }
    expect(F.notifications.length).toBeGreaterThanOrEqual(2);
    const kinds = negatives.map(([, f]) => f.kind);
    expect(kinds).toEqual(expect.arrayContaining(['no-new-mint', 'not-signer', 'failed']));
    expect(positives.every(([, f]) => !f.expectedMint?.startsWith('AMBIGUOUS'))).toBe(true);
  });

  it('hold no API key or URL with a key', () => {
    const text = readFileSync('tests/fixtures/detectors.mainnet.json', 'utf8');
    expect(text).not.toMatch(/api-key=/u);
  });
});

describe('slow path: inner instructions (CPI)', () => {
  // Every launchpad create in the fixtures initializes its mint only through a CPI to the
  // token program. With the launchpad's program id swapped for an unknown program, its
  // detector cannot match, and only the generic path reading inner instructions finds
  // the mint (review of PR #26).
  const UNKNOWN_PROGRAM = 'Stake11111111111111111111111111111111111111';
  const launchpads = {
    [PUMP_FUN_PROGRAM]: positives.filter(([, f]) => f.expectedSource === 'pump.fun'),
    [METEORA_DBC_PROGRAM]: positives.filter(([, f]) => f.expectedSource === 'meteora-dbc'),
    [RAYDIUM_LAUNCHLAB_PROGRAM]: positives.filter(
      ([, f]) => f.expectedSource === 'raydium-launchlab',
    ),
  };
  const cases = Object.entries(launchpads).flatMap(([program, list]) =>
    list.map(([name, f]) => [name, program, f] as const),
  );

  it.each(cases)(
    '%s: unknown launchpad, mint found by the inner InitializeMint',
    (_n, program, f) => {
      const swapped = asTransaction(
        JSON.parse(JSON.stringify(f.tx).replaceAll(program, UNKNOWN_PROGRAM)) as unknown,
      );
      if (!swapped) throw new Error('fixture is not a transaction');
      expect(detectFromTransaction(swapped, f.watched)).toEqual([
        { mint: f.expectedMint, source: 'initialize-mint' },
      ]);
    },
  );
});

describe('slow path (getTransaction)', () => {
  it.each(positives)('%s: the right mint and source', (_name, f) => {
    expect(detectFromTransaction(txOf(f), f.watched)).toEqual([
      { mint: f.expectedMint, source: f.expectedSource },
    ]);
  });

  it.each(negatives)('%s: no detection', (_name, f) => {
    expect(detectFromTransaction(txOf(f), f.watched)).toEqual([]);
  });

  it('a launchpad mint taken by someone else who signs nothing is not detected', () => {
    const [, f] = positives[0] ?? [];
    if (!f) throw new Error('no fixture');
    expect(detectFromTransaction(txOf(f), 'Stranger1111111111111111111111111111111111')).toEqual(
      [],
    );
  });
});

describe('fast path (log)', () => {
  it.each(F.notifications.map((n) => [n.message.params.result.value.signature, n] as const))(
    'pump.fun %s: the mint from the log alone',
    (_sig, n) => {
      expect(detectFromLogs(n.message.params.result.value.logs, n.watched)).toEqual([
        { mint: n.expectedMint, source: 'pump.fun' },
      ]);
    },
  );

  it('CreateEvent whose user is not the watched address: no fast detection', () => {
    const n = F.notifications[0];
    if (!n) throw new Error('no fixture');
    const logs = n.message.params.result.value.logs;
    expect(detectFromLogs(logs, 'Stranger1111111111111111111111111111111111')).toEqual([]);
  });

  it('the same event written under another program (wrong invoke stack) is ignored', () => {
    const n = F.notifications[0];
    if (!n) throw new Error('no fixture');
    const real = programData(n.message.params.result.value.logs).find(
      (d) => d.program === PUMP_FUN_PROGRAM,
    );
    if (!real) throw new Error('no CreateEvent');
    const fake = [
      'Program Fake111111111111111111111111111111111111 invoke [1]',
      `Program data: ${base64.encode(real.data)}`,
      'Program Fake111111111111111111111111111111111111 success',
      // pump.fun did run in this transaction, but wrote nothing
      `Program ${PUMP_FUN_PROGRAM} invoke [1]`,
      `Program ${PUMP_FUN_PROGRAM} success`,
    ];
    expect(detectFromLogs(fake, n.watched)).toEqual([]);
  });

  it('a failed transaction’s log never reaches the detectors (the stream drops err)', () => {
    // covered by the stream (BUNNDLY-32); here: logs of a failed pump.fun call
    const logs = [
      `Program ${PUMP_FUN_PROGRAM} invoke [1]`,
      `Program ${PUMP_FUN_PROGRAM} failed: custom program error: 0x1`,
    ];
    expect(detectFromLogs(logs, 'x')).toEqual([]);
  });
});

describe('detector (both paths)', () => {
  function setup(answers: (signature: string, call: number) => unknown) {
    const clock = new FakeClock(true);
    const events: DetectorEvent[] = [];
    const calls: string[] = [];
    let n = 0;
    const detector = createDetector(
      {
        getTransaction: (sig) => {
          calls.push(sig);
          return Promise.resolve(answers(sig, ++n));
        },
        clock,
        emit: (e) => events.push(e),
      },
      { watched: F.notifications[0]?.watched ?? '' },
    );
    return { clock, events, calls, detector };
  }

  const live = (n: FixtureNotification): SignatureInput => ({
    signature: n.message.params.result.value.signature,
    source: 'logs',
    logs: n.message.params.result.value.logs,
    receivedAt: 42,
  });

  it('pump.fun from a live log: detected before any RPC call; the transaction verifies it once', async () => {
    const n = F.notifications[0];
    if (!n) throw new Error('no fixture');
    const clock = new FakeClock(true);
    const events: DetectorEvent[] = [];
    let rpcCalls = 0;
    let rpcBeforeDetection = -1;
    const detector = createDetector(
      {
        getTransaction: () => {
          rpcCalls += 1;
          return Promise.resolve(n.tx);
        },
        clock,
        emit: (e) => {
          if (rpcBeforeDetection < 0 && e.kind === 'detection') rpcBeforeDetection = rpcCalls;
          events.push(e);
        },
      },
      { watched: n.watched },
    );
    detector.onSignature(live(n));
    expect(rpcBeforeDetection).toBe(0); // the mint came from the log alone
    await clock.runUntil();
    await detector.idle();
    expect(events).toEqual([
      {
        kind: 'detection',
        detection: {
          mint: n.expectedMint,
          source: 'pump.fun',
          path: 'log',
          signature: n.message.params.result.value.signature,
          slot: null,
          blockTime: null,
          receivedAt: 42,
        },
      },
      {
        kind: 'verified',
        mint: n.expectedMint,
        signature: n.message.params.result.value.signature,
        match: true,
      },
    ]);
  });

  it('getTransaction with null three times, then the transaction: detected (slow path)', async () => {
    const [, f] = positives.find(([, x]) => x.expectedSource === 'raydium-launchlab') ?? [];
    if (!f) throw new Error('no fixture');
    const clock = new FakeClock(true);
    const events: DetectorEvent[] = [];
    let n = 0;
    const detector = createDetector(
      {
        getTransaction: () => Promise.resolve(++n <= 3 ? null : f.tx),
        clock,
        emit: (e) => events.push(e),
      },
      { watched: f.watched },
    );
    detector.onSignature({ signature: f.signature, source: 'catch-up', logs: null, receivedAt: 7 });
    await clock.runUntil();
    await detector.idle();
    expect(n).toBe(4);
    expect(events).toEqual([
      {
        kind: 'detection',
        detection: {
          mint: f.expectedMint,
          source: 'raydium-launchlab',
          path: 'catch-up',
          signature: f.signature,
          slot: BigInt((f.tx as { slot: number }).slot),
          blockTime: (f.tx as { blockTime: number }).blockTime,
          receivedAt: 7,
        },
      },
    ]);
  });

  it('null until 15 s: no detection, one "transaction-unavailable"', async () => {
    const { clock, events, calls, detector } = setup(() => null);
    detector.onSignature({ signature: 'Sig', source: 'logs', logs: [], receivedAt: 0 });
    await clock.runUntil();
    await detector.idle();
    expect(events).toEqual([{ kind: 'transaction-unavailable', signature: 'Sig' }]);
    expect(calls.length).toBeGreaterThanOrEqual(15_000 / 200);
    expect(clock.now() - T0).toBeGreaterThanOrEqual(15_000);
  });

  it('stop (disarm): polling ends, no more events, new signatures ignored', async () => {
    const { clock, events, calls, detector } = setup(() => null);
    detector.onSignature({ signature: 'Sig', source: 'logs', logs: [], receivedAt: 0 });
    await clock.runUntil(T0 + 1_000);
    const asked = calls.length;
    detector.stop();
    detector.onSignature({ signature: 'Other', source: 'logs', logs: [], receivedAt: 0 });
    await clock.runUntil();
    await detector.idle();
    expect(calls.length).toBeLessThanOrEqual(asked + 1);
    expect(calls).not.toContain('Other');
    expect(events).toEqual([]);
  });

  it('the same mint from the log and from catch-up: one detection', async () => {
    const n = F.notifications[0];
    if (!n) throw new Error('no fixture');
    const { clock, events, detector } = setup(() => n.tx);
    detector.onSignature(live(n));
    detector.onSignature({ ...live(n), source: 'catch-up', logs: null });
    await clock.runUntil();
    await detector.idle();
    expect(events.filter((e) => e.kind === 'detection')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'verified')).toHaveLength(1);
  });

  it('a fast-path mint the transaction does not confirm: a warning, not a second detection', async () => {
    const n = F.notifications[0];
    const other = F.notifications[1];
    if (!n || !other) throw new Error('no fixture');
    const { clock, events, detector } = setup(() => other.tx);
    detector.onSignature(live(n));
    await clock.runUntil();
    await detector.idle();
    expect(events.filter((e) => e.kind === 'detection')).toHaveLength(1);
    expect(events.find((e) => e.kind === 'verified')).toMatchObject({ match: false });
  });
});
