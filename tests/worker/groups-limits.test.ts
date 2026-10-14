/**
 * Wallet groups in the vault worker (BUNNDLY-68): the request limit shared by every group
 * and the auto-lock while any group works. Split out of groups.test.ts in BUNNDLY-74 to run
 * in parallel; same fleet and fakes (groups-fleet.ts).
 */
import { describe, expect, it, vi } from 'vitest';
import { USDC } from '../helpers/tx-fakes.ts';
import { MINT, setup } from './groups-fleet.ts';

// The key derivation is not the subject here: the fast stand-in keeps the key bound to
// the password, the salt and the cost (tests/helpers/fast-kdf.ts, BUNNDLY-74).
vi.mock('@noble/hashes/scrypt.js', () => import('../helpers/fast-kdf.ts'));

vi.setConfig({ testTimeout: 60_000 });

describe('one request limit for every group (SPEC 2.2)', () => {
  it('two groups of 15 at once, Keyless: 27 /order in the first minute, the other 3 after it', async () => {
    // 30 a minute without a Jupiter key, 90 % of it: 27 (worked out by hand)
    const range = (from: number, to: number) =>
      Array.from({ length: to - from }, (_, i) => from + i);
    const t = await setup(100, {
      count: 30,
      groups: [
        { id: 'g1', name: 'First', wallets: range(0, 15) },
        { id: 'g2', name: 'Second', wallets: range(15, 30) },
      ],
    });
    const started = t.clock.now();
    await t.startBuy('g1');
    await t.h.handle({ type: 'startBuy', group: 'g2', mint: MINT });
    await t.clock.runUntil(started + 55_000);
    expect(t.orders).toHaveLength(27);
    expect(t.askedBy(USDC).length).toBeGreaterThan(0);
    expect(t.askedBy(MINT).length).toBeGreaterThan(0);
    await t.untilIdle();
    expect(t.askedBy(USDC)).toEqual(range(0, 15));
    expect(t.askedBy(MINT)).toEqual(range(15, 30));
  });
});

describe('auto-lock with groups', () => {
  it('no auto-lock while any group buys or watches; after all of them end it locks', async () => {
    const t = await setup();
    await t.startBuy('g1');
    await t.arm('g2');
    await t.clock.runUntil(t.clock.now() + 61_000);
    expect(t.h.checkAutoLock()).toBe(false);
    await t.h.handle({ type: 'stop', group: 'g1' });
    await t.untilIdle();
    await t.clock.runUntil(t.clock.now() + 61_000);
    expect(t.h.checkAutoLock()).toBe(false); // B still watches
    await t.h.handle({ type: 'disarm', group: 'g2' });
    expect(t.h.checkAutoLock()).toBe(false); // the disarm was activity
    await t.clock.runUntil(t.clock.now() + 61_000);
    expect(t.h.checkAutoLock()).toBe(true);
    expect((await t.status()).groups).toEqual([]);
  });
});
