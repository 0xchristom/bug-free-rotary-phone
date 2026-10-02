/**
 * Test setup: tests use mocks only, never the real network (project rule). Any fetch or
 * WebSocket fails loudly instead of reaching Helius, Jupiter or a public RPC.
 */
import { beforeEach, vi } from 'vitest';

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new Error('Network access is not allowed in tests'))),
  );
  vi.stubGlobal(
    'WebSocket',
    vi.fn(() => {
      throw new Error('Network access is not allowed in tests');
    }),
  );
});
