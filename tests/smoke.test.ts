import { describe, expect, it } from 'vitest';

describe('smoke', () => {
  it('runs in the Node environment with bigint support', () => {
    expect('window' in globalThis).toBe(false);
    expect(10n ** 9n).toBe(1_000_000_000n);
  });
});
