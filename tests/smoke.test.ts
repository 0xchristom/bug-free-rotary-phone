import { describe, expect, it } from 'vitest';

describe('smoke', () => {
  it('runs in the Node environment with bigint support', () => {
    expect('window' in globalThis).toBe(false);
    expect(10n ** 9n).toBe(1_000_000_000n);
  });
});

describe('no network in tests', () => {
  it('fetch is blocked', async () => {
    await expect(fetch('https://api.mainnet.solana.com')).rejects.toThrow('not allowed in tests');
  });
});
