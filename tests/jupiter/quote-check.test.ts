/** Jupiter quote check (BUNNDLY-16) against a mocked fetch. */
import { describe, expect, it } from 'vitest';
import {
  JUPITER_ORDER_URL,
  SOL_MINT,
  USDC_MINT,
  checkJupiterQuote,
} from '../../src/jupiter/quote-check.ts';
import { QUOTE_BODY, fakeFetch, stepClock } from '../helpers/net-fakes.ts';

const KEY = 'jupiterSecretKey555';

/** A real keyless answer without taker (2026-10-02 fixture). */
const QUOTE = QUOTE_BODY;
const LIMITS = {
  'x-ratelimit-remaining': '4',
  'x-ratelimit-current': '1',
  'x-ratelimit-reset': '1790966971',
};

describe('Jupiter quote check', () => {
  it('GET /swap/v2/order SOL → USDC, 0.01 SOL, no taker, with x-api-key', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, json: QUOTE, headers: LIMITS }));
    const r = await checkJupiterQuote({ apiKey: KEY, fetch, timeoutMs: 1000, clock: stepClock() });
    expect(r).toEqual({
      ok: true,
      ms: 7,
      problem: null,
      httpStatus: null,
      keyless: false,
      outAmount: '1174568',
      router: 'metis',
      rateLimit: { remaining: 4, current: 1, reset: 1_790_966_971 },
    });
    const call = calls[0];
    if (!call) throw new Error('no call');
    const url = new URL(call.url);
    expect(`${url.origin}${url.pathname}`).toBe(JUPITER_ORDER_URL);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      inputMint: SOL_MINT,
      outputMint: USDC_MINT,
      amount: '10000000',
    });
    expect(url.searchParams.has('taker')).toBe(false);
    expect(call.method).toBe('GET');
    expect(call.headers).toEqual({ 'x-api-key': KEY });
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it('without a key: Keyless, no x-api-key header', async () => {
    const { fetch, calls } = fakeFetch(() => ({ status: 200, json: QUOTE, headers: LIMITS }));
    const r = await checkJupiterQuote({ apiKey: null, fetch, timeoutMs: 1000, clock: stepClock() });
    expect(r).toMatchObject({ ok: true, keyless: true });
    expect(calls[0]?.headers).toEqual({});
  });

  it('429 keeps the rate limit headers (they tell when to retry)', async () => {
    const { fetch } = fakeFetch(() => ({
      status: 429,
      json: { message: 'Rate limit exceeded' },
      headers: { ...LIMITS, 'x-ratelimit-remaining': '-2', 'x-ratelimit-current': '7' },
    }));
    const r = await checkJupiterQuote({ apiKey: KEY, fetch, timeoutMs: 1000, clock: stepClock() });
    expect(r).toMatchObject({
      ok: false,
      problem: 'RATE_LIMITED',
      httpStatus: 429,
      rateLimit: { remaining: -2, current: 7, reset: 1_790_966_971 },
    });
  });

  it.each([
    [401, 'UNAUTHORIZED'],
    [403, 'FORBIDDEN'],
    [500, 'SERVER_ERROR'],
  ] as const)('HTTP %i → %s, no rate limit headers, no key', async (status, problem) => {
    const { fetch } = fakeFetch(() => ({ status, json: { error: `invalid key ${KEY}` } }));
    const r = await checkJupiterQuote({ apiKey: KEY, fetch, timeoutMs: 1000, clock: stepClock() });
    expect(r).toMatchObject({ ok: false, problem, httpStatus: status, rateLimit: null });
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it('timeout and network error', async () => {
    const hang = fakeFetch(() => 'hang');
    expect(
      await checkJupiterQuote({
        apiKey: KEY,
        fetch: hang.fetch,
        timeoutMs: 20,
        clock: stepClock(),
      }),
    ).toMatchObject({ ok: false, problem: 'TIMEOUT', httpStatus: null });
    const down = fakeFetch(() => 'network-error');
    expect(
      await checkJupiterQuote({
        apiKey: KEY,
        fetch: down.fetch,
        timeoutMs: 1000,
        clock: stepClock(),
      }),
    ).toMatchObject({ ok: false, problem: 'NETWORK' });
  });

  it('an answer that is not a quote (a transaction, odd amount or router) is refused', async () => {
    for (const body of [
      { ...QUOTE, transaction: 'AQAB' },
      { ...QUOTE, outAmount: '1e6' },
      { ...QUOTE, router: '<img src=x>' },
      'not an object',
    ]) {
      const { fetch } = fakeFetch(() => ({ status: 200, json: body }));
      const r = await checkJupiterQuote({
        apiKey: null,
        fetch,
        timeoutMs: 1000,
        clock: stepClock(),
      });
      expect(r).toMatchObject({ ok: false, problem: 'INVALID_RESPONSE', outAmount: null });
    }
  });

  it('only the rate limit headers that came are shown; none at all is not an error', async () => {
    const partial = fakeFetch(() => ({
      status: 200,
      json: QUOTE,
      headers: { 'x-ratelimit-remaining': '4', 'x-ratelimit-reset': 'soon' },
    }));
    expect(
      await checkJupiterQuote({
        apiKey: null,
        fetch: partial.fetch,
        timeoutMs: 1000,
        clock: stepClock(),
      }),
    ).toMatchObject({ ok: true, rateLimit: { remaining: 4, current: null, reset: null } });

    const none = fakeFetch(() => ({ status: 200, json: QUOTE }));
    expect(
      await checkJupiterQuote({
        apiKey: null,
        fetch: none.fetch,
        timeoutMs: 1000,
        clock: stepClock(),
      }),
    ).toMatchObject({ ok: true, problem: null, rateLimit: null });
  });
});
