/**
 * Jupiter Swap API V2 client (BUNNDLY-19) against real `/order` answers (Keyless,
 * 2026-10-02) and `/execute` answers built from the docs. Mocked fetch only.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  EXECUTE_CODES,
  JUPITER_MESSAGES,
  SOL_MINT,
  createJupiterClient,
  executeOutcome,
  orderBuildReason,
  parseExecution,
  parseOrder,
  type JupiterFailure,
  type JupiterFailureCode,
  type JupiterOrder,
  type JupiterResult,
  type OrderBuildReason,
} from '../../src/jupiter/index.ts';
import { fakeFetch, type FetchReply } from '../helpers/net-fakes.ts';

const KEY = 'jupiterSecretKey777';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TAKER = 'sp1nLqqjVZ1kTusFjJmHp1xHDpH6M4F7KXCr1iJ3xpX';

interface FixtureCase {
  readonly request: { readonly query: Record<string, string> };
  readonly response: {
    readonly status: number;
    readonly headers: Record<string, string>;
    readonly body: unknown;
  };
}
const ORDER = (
  JSON.parse(readFileSync('tests/fixtures/jupiter-order.mainnet.json', 'utf8')) as {
    cases: Record<string, FixtureCase>;
  }
).cases;
const EXECUTE = JSON.parse(readFileSync('tests/fixtures/jupiter-execute.docs.json', 'utf8')) as {
  success: Record<string, unknown>;
  failed: Record<string, Record<string, unknown>>;
  badRequest400: Record<string, unknown>;
  serverError500: Record<string, unknown>;
};

function fixture(name: string): FixtureCase {
  const c = ORDER[name];
  if (!c) throw new Error(name);
  return c;
}

function replay(name: string) {
  const c = fixture(name);
  return fakeFetch(() => ({
    status: c.response.status,
    json: c.response.body,
    headers: c.response.headers,
  }));
}

function client(reply: (body: unknown) => FetchReply, apiKey: string | null = KEY) {
  const net = fakeFetch((call) => reply(call.body));
  return { net, jupiter: createJupiterClient({ apiKey, fetch: net.fetch, orderTimeoutMs: 1000 }) };
}

function value<T>(r: JupiterResult<T>): T {
  if (!r.ok) throw new Error(`expected ok, got ${r.code}`);
  return r.value;
}

function failed<T>(r: JupiterResult<T>): JupiterFailure {
  if (r.ok) throw new Error('expected a failure');
  return r;
}

async function orderFrom(name: string): Promise<JupiterResult<JupiterOrder>> {
  const c = fixture(name);
  const net = replay(name);
  const jupiter = createJupiterClient({ apiKey: null, fetch: net.fetch });
  const q = c.request.query;
  return jupiter.getOrder({
    outputMint: q.outputMint ?? USDC,
    amount: BigInt(q.amount ?? '0'),
    ...(q.taker === undefined ? {} : { taker: q.taker }),
  });
}

describe('GET /order request', () => {
  it('sends exactly inputMint, outputMint, amount and taker, with x-api-key only with a key', async () => {
    const withKey = client(() => ({ status: 200, json: fixture('metisSuccess').response.body }));
    await withKey.jupiter.getOrder({ outputMint: USDC, amount: 10_000_000n, taker: TAKER });
    const call = withKey.net.calls[0];
    if (!call) throw new Error('no call');
    const url = new URL(call.url);
    expect(`${url.origin}${url.pathname}`).toBe('https://api.jup.ag/swap/v2/order');
    expect([...url.searchParams.entries()]).toEqual([
      ['inputMint', SOL_MINT],
      ['outputMint', USDC],
      ['amount', '10000000'],
      ['taker', TAKER],
    ]);
    expect(call.method).toBe('GET');
    expect(call.headers).toEqual({ 'x-api-key': KEY });

    const keyless = client(() => ({ status: 200, json: fixture('noTaker').response.body }), null);
    await keyless.jupiter.getOrder({ outputMint: USDC, amount: 10_000_000n });
    expect(keyless.net.calls[0]?.headers).toEqual({});
    expect([...new URL(keyless.net.calls[0]?.url ?? '').searchParams.keys()]).toEqual([
      'inputMint',
      'outputMint',
      'amount',
    ]);
  });

  it('an amount of 0 is refused without a call', async () => {
    const { net, jupiter } = client(() => ({ status: 200 }));
    expect(failed(await jupiter.getOrder({ outputMint: USDC, amount: 0n })).code).toBe(
      'BAD_REQUEST',
    );
    expect(net.calls).toHaveLength(0);
  });
});

describe('real /order answers (fixtures)', () => {
  it('metis: a transaction, amounts and block height as bigint, the taker pays gas', async () => {
    const r = await orderFrom('metisSuccess');
    const o = value(r);
    expect(o).toMatchObject({
      router: 'metis',
      inputMint: SOL_MINT,
      outputMint: USDC,
      inAmount: 10_000_000n,
      outAmount: 1_180_880n,
      taker: TAKER,
      signatureFeePayer: TAKER,
      prioritizationFeePayer: TAKER,
      rentFeePayer: TAKER,
      gasless: false,
      buildError: null,
      expireAt: null,
      feeMint: SOL_MINT,
      feeBps: 2,
    });
    expect(o.lastValidBlockHeight).toBe(430_752_662n);
    expect(typeof o.transaction).toBe('string');
    expect(o.otherAmountThreshold).toBeTypeOf('bigint');
    expect(r.rateLimit).not.toBeNull();
  });

  it('jupiterz: RFQ expiry instead of block height; the market maker pays the signature', async () => {
    const o = value(await orderFrom('jupiterzSuccess'));
    expect(o.router).toBe('jupiterz');
    expect(o.lastValidBlockHeight).toBeNull();
    expect(o.expireAt).toBe(1_790_971_933);
    expect(o.gasless).toBe(true);
    expect(o.signatureFeePayer).not.toBe(TAKER);
    expect(typeof o.transaction).toBe('string');
  });

  it('empty taker: a price but no transaction, errorCode 1 → insufficient funds', async () => {
    const o = value(await orderFrom('emptyTaker'));
    expect(o.transaction).toBeNull();
    expect(o.buildError).toEqual({ errorCode: 1, reason: 'INSUFFICIENT_FUNDS' });
    expect(o.outAmount).toBeGreaterThan(0n);
    expect(o.signatureFeePayer).toBeNull();
  });

  it('no taker: a quote only', async () => {
    const o = value(await orderFrom('noTaker'));
    expect(o.transaction).toBeNull();
    expect(o.buildError).toBeNull();
    expect(o.taker).toBeNull();
  });

  it('a mint without liquidity is NO_ROUTE (HTTP 400 "Failed to get quotes"), with limits', async () => {
    const f = failed(await orderFrom('noRoute'));
    expect(f).toMatchObject({ code: 'NO_ROUTE', httpStatus: 400, signature: null });
    expect(f.rateLimit).not.toBeNull();
  });

  it('an invalid mint is BAD_REQUEST', async () => {
    expect(failed(await orderFrom('badMint'))).toMatchObject({
      code: 'BAD_REQUEST',
      httpStatus: 400,
    });
  });
});

describe('transaction "" reasons by (router, errorCode)', () => {
  const pairs: [string, number | null, OrderBuildReason][] = [
    ['metis', 1, 'INSUFFICIENT_FUNDS'],
    ['dflow', 2, 'INSUFFICIENT_SOL_FOR_GAS'],
    ['okx', 3, 'BELOW_GASLESS_MINIMUM'],
    ['jupiterz', 1, 'INSUFFICIENT_FUNDS'],
    ['jupiterz', 2, 'MISSING_TOKEN_ACCOUNT'],
    ['jupiterz', 3, 'QUOTE_NOT_BUILDABLE'],
    ['metis', 4, 'OTHER'],
    ['newrouter', 1, 'OTHER'],
    ['jupiterz', null, 'OTHER'],
  ];
  it.each(pairs)('%s + %s → %s', (router, errorCode, reason) => {
    expect(orderBuildReason(router, errorCode)).toBe(reason);
    const body = {
      ...(fixture('emptyTaker').response.body as Record<string, unknown>),
      router,
      errorCode: errorCode ?? undefined,
    };
    expect(parseOrder(body)?.buildError).toEqual({ errorCode, reason });
  });
});

describe('a broken /order answer is a failure code, never an exception', () => {
  const base = fixture('metisSuccess').response.body as Record<string, unknown>;
  const broken: [string, unknown][] = [
    ['not an object', 'Internal Server Error'],
    ['null', null],
    ['no requestId', { ...base, requestId: undefined }],
    ['no router', { ...base, router: undefined }],
    ['router with markup', { ...base, router: '<b>x</b>' }],
    ['amount as number', { ...base, outAmount: 1_180_880 }],
    ['amount not decimal', { ...base, inAmount: '1e7' }],
    ['no signatureFeePayer', { ...base, signatureFeePayer: undefined }],
    ['transaction not base64', { ...base, transaction: '%%%' }],
    ['transaction too long', { ...base, transaction: 'A'.repeat(5000) }],
    ['gasless as text', { ...base, gasless: 'yes' }],
    ['block height as number', { ...base, lastValidBlockHeight: 430_752_662 }],
    ['bad mint', { ...base, outputMint: 'x' }],
  ];
  it.each(broken)('%s → INVALID_RESPONSE', async (_name, body) => {
    const { jupiter } = client(() => ({ status: 200, json: body }));
    const f = failed(await jupiter.getOrder({ outputMint: USDC, amount: 1n, taker: TAKER }));
    expect(f).toMatchObject({ code: 'INVALID_RESPONSE', httpStatus: 200 });
  });

  it('extra fields are fine', () => {
    expect(parseOrder({ ...base, somethingNew: { a: 1 } })).toBeDefined();
  });
});

describe('HTTP and network failures', () => {
  const limits = {
    'x-ratelimit-remaining': '-1',
    'x-ratelimit-current': '6',
    'x-ratelimit-reset': '1790971864',
  };
  const cases: [string, FetchReply, JupiterFailureCode, number | null][] = [
    [
      '429 with headers',
      { status: 429, json: { error: 'Rate limit' }, headers: limits },
      'RATE_LIMITED',
      429,
    ],
    ['429 without headers', { status: 429, json: {} }, 'RATE_LIMITED', 429],
    ['500', { status: 500, json: { error: 'Something unexpected occurred' } }, 'SERVER_ERROR', 500],
    ['503 not JSON', { status: 503 }, 'SERVER_ERROR', 503],
    ['401', { status: 401, json: { error: `bad key ${KEY}` } }, 'UNAUTHORIZED', 401],
    ['403', { status: 403, json: {} }, 'FORBIDDEN', 403],
    ['418', { status: 418 }, 'HTTP_ERROR', 418],
    ['timeout', 'hang', 'TIMEOUT', null],
    ['network error', 'network-error', 'NETWORK', null],
  ];
  it.each(cases)('%s → %s; no key or URL in the result', async (_n, reply, code, status) => {
    const net = fakeFetch(() => reply);
    const jupiter = createJupiterClient({ apiKey: KEY, fetch: net.fetch, orderTimeoutMs: 20 });
    const f = failed(await jupiter.getOrder({ outputMint: USDC, amount: 1n, taker: TAKER }));
    expect(f.code).toBe(code);
    expect(f.httpStatus).toBe(status);
    const text = JSON.stringify(f);
    expect(text).not.toContain(KEY);
    expect(text).not.toContain('api.jup.ag');
  });

  it('429 keeps each rate limit header that came', async () => {
    const net = fakeFetch(() => ({ status: 429, json: {}, headers: limits }));
    const jupiter = createJupiterClient({ apiKey: null, fetch: net.fetch });
    const f = failed(await jupiter.getOrder({ outputMint: USDC, amount: 1n }));
    expect(f.rateLimit).toEqual({ remaining: -1, current: 6, reset: 1_790_971_864 });
  });
});

describe('POST /execute', () => {
  const SIGNED = 'AQAB'.repeat(10);

  it('sends signedTransaction, requestId and lastValidBlockHeight as JSON with the key', async () => {
    const { net, jupiter } = client(() => ({ status: 200, json: EXECUTE.success }));
    const r = await jupiter.execute({
      signedTransaction: SIGNED,
      requestId: 'req-1',
      lastValidBlockHeight: 430_752_662n,
    });
    const call = net.calls[0];
    expect(call?.url).toBe('https://api.jup.ag/swap/v2/execute');
    expect(call?.method).toBe('POST');
    expect(call?.headers).toEqual({ 'x-api-key': KEY, 'content-type': 'application/json' });
    expect(call?.body).toEqual({
      signedTransaction: SIGNED,
      requestId: 'req-1',
      lastValidBlockHeight: '430752662',
    });
    expect(value(r)).toMatchObject({
      status: 'Success',
      code: 0,
      outcome: 'SUCCESS',
      slot: 452_713_600n,
      totalInputAmount: 10_000_000n,
      totalOutputAmount: 2101n,
      inputAmountResult: 10_000_000n,
      outputAmountResult: 2103n,
    });
    expect(value(r).signature).toBe(EXECUTE.success.signature);
  });

  it('every documented code has its own outcome', () => {
    const documented = Object.keys(EXECUTE.failed).map(Number);
    expect(documented.sort((a, b) => a - b)).toEqual(
      Object.keys(EXECUTE_CODES)
        .map(Number)
        .filter((c) => c !== 0)
        .sort((a, b) => a - b),
    );
    const outcomes = new Set<string>();
    for (const [code, body] of Object.entries(EXECUTE.failed)) {
      const e = parseExecution(body);
      expect(e).toMatchObject({ status: 'Failed', code: Number(code) });
      expect(e?.outcome).not.toBe('UNDOCUMENTED');
      outcomes.add(e?.outcome ?? '');
    }
    expect(outcomes.size).toBe(13);
    expect(executeOutcome(-1)).toBe('ORDER_NOT_FOUND');
    expect(executeOutcome(-1004)).toBe('AGGREGATOR_INVALID_BLOCK_HEIGHT');
    expect(executeOutcome(-2003)).toBe('RFQ_QUOTE_EXPIRED');
    expect(executeOutcome(-42)).toBe('UNDOCUMENTED');
  });

  it('HTTP 400 with a code is a typed failed execution; without a code BAD_REQUEST', async () => {
    const withCode = client(() => ({ status: 400, json: EXECUTE.badRequest400 }));
    expect(
      value(await withCode.jupiter.execute({ signedTransaction: SIGNED, requestId: 'r' })),
    ).toMatchObject({ status: 'Failed', code: -1, outcome: 'ORDER_NOT_FOUND', signature: null });
    const noCode = client(() => ({ status: 400, json: { error: 'bad' } }));
    expect(
      failed(await noCode.jupiter.execute({ signedTransaction: SIGNED, requestId: 'r' })).code,
    ).toBe('BAD_REQUEST');
  });

  it('HTTP 500 keeps the signature that may still land; timeout and broken answers', async () => {
    const server = client(() => ({ status: 500, json: EXECUTE.serverError500 }));
    expect(
      failed(await server.jupiter.execute({ signedTransaction: SIGNED, requestId: 'r' })),
    ).toMatchObject({ code: 'SERVER_ERROR', signature: EXECUTE.serverError500.signature });

    const net = fakeFetch(() => 'hang');
    const slow = createJupiterClient({ apiKey: KEY, fetch: net.fetch, executeTimeoutMs: 20 });
    expect(failed(await slow.execute({ signedTransaction: SIGNED, requestId: 'r' })).code).toBe(
      'TIMEOUT',
    );

    for (const body of [
      { status: 'Success', code: -1000 },
      { status: 'Done', code: 0 },
      { status: 'Success' },
      { ...EXECUTE.success, totalOutputAmount: 2101 },
      'ok',
    ]) {
      const broken = client(() => ({ status: 200, json: body }));
      expect(
        failed(await broken.jupiter.execute({ signedTransaction: SIGNED, requestId: 'r' })).code,
      ).toBe('INVALID_RESPONSE');
    }
  });
});

describe('Polish messages', () => {
  it('exist for every failure, build reason and execute outcome', () => {
    const failures: JupiterFailureCode[] = [
      'RATE_LIMITED',
      'SERVER_ERROR',
      'TIMEOUT',
      'NETWORK',
      'NO_ROUTE',
      'BAD_REQUEST',
      'UNAUTHORIZED',
      'FORBIDDEN',
      'HTTP_ERROR',
      'INVALID_RESPONSE',
    ];
    for (const code of failures) expect(JUPITER_MESSAGES.failure(code)).toMatch(/\p{Lu}/u);
    for (const reason of [
      'INSUFFICIENT_FUNDS',
      'INSUFFICIENT_SOL_FOR_GAS',
      'BELOW_GASLESS_MINIMUM',
      'MISSING_TOKEN_ACCOUNT',
      'QUOTE_NOT_BUILDABLE',
      'OTHER',
    ] as const) {
      expect(JUPITER_MESSAGES.buildReason(reason).length).toBeGreaterThan(10);
    }
    for (const outcome of [...Object.values(EXECUTE_CODES), 'UNDOCUMENTED' as const]) {
      expect(JUPITER_MESSAGES.executeOutcome(outcome).length).toBeGreaterThan(10);
    }
  });
});
