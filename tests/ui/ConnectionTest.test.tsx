// @vitest-environment jsdom
/** "Test connections" on the settings screen (BUNNDLY-16), real vault handler, mocked net. */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultFleetSettings } from '../../src/core/index.ts';
import { App } from '../../src/ui/App.tsx';
import { createVaultHandler } from '../../src/worker/vault.ts';
import type { VaultClient } from '../../src/worker/vault-client.ts';
import {
  FakeSocket,
  QUOTE_BODY,
  fakeFetch,
  heliusSocket,
  stepClock,
  type FetchReply,
} from '../helpers/net-fakes.ts';
import { mockStorage } from './fakes.ts';
import { setupUser } from './user.ts';

// The key derivation is not the subject here: the fast stand-in keeps the key bound to
// the password, the salt and the cost (tests/helpers/fast-kdf.ts, BUNNDLY-74).
vi.mock('@noble/hashes/scrypt.js', () => import('../helpers/fast-kdf.ts'));

const HELIUS = 'heliusKeyUiConn123';
const JUPITER = 'jupiterKeyUiConn456';

vi.setConfig({ testTimeout: 60_000 });

async function setup(
  helius: (body: { id: number; method: string }) => FetchReply,
  network: 'mainnet' | 'devnet' = 'mainnet',
) {
  const { fetch, calls } = fakeFetch((call) =>
    call.url.startsWith('https://api.jup.ag/')
      ? {
          status: 200,
          json: QUOTE_BODY,
          headers: {
            'x-ratelimit-remaining': '58',
            'x-ratelimit-current': '2',
            'x-ratelimit-reset': '1790966971',
          },
        }
      : helius(call.body as { id: number; method: string }),
  );
  const handler = createVaultHandler({
    net: {
      fetch,
      createWebSocket: (url) => {
        const socket = new FakeSocket(url);
        queueMicrotask(() => {
          heliusSocket(socket, 452_700_000);
        });
        return socket;
      },
      timeoutMs: 1000,
      clock: stepClock(),
    },
  });
  await handler.handle({
    type: 'create',
    fleetName: 'Test',
    walletCount: 2,
    password: 'x'.repeat(16),
  });
  await handler.handle({
    type: 'saveSettings',
    settings: defaultFleetSettings(),
    apiKeys: { helius: HELIUS, jupiter: JUPITER },
  });
  if (network !== 'mainnet') await handler.handle({ type: 'setNetwork', network });
  const client = {
    request: (r: unknown, o?: object) => handler.handle(r, o),
    onEvent: (l) => handler.onEvent(l),
  } as VaultClient;
  render(<App vault={client} storage={mockStorage().env} statusPollMs={60_000} />);
  const user = setupUser();
  const nav = await screen.findByRole('navigation', {}, { timeout: 10_000 });
  await user.click(within(nav).getByRole('button', { name: 'Settings' }));
  await user.click(await screen.findByRole('button', { name: 'Test connections' }));
  const table = await screen.findByRole('table', { name: 'Connection test results' });
  const row = (name: RegExp) =>
    within(table).getByRole('rowheader', { name }).closest('tr')?.textContent ?? '';
  return { row, calls };
}

afterEach(cleanup);

describe('connection test in the settings', () => {
  it('shows OK, times, the quote and the rate limit headers; keys never reach the page', async () => {
    const { row } = await setup((b) => ({
      status: 200,
      json: { jsonrpc: '2.0', id: b.id, result: b.method === 'getHealth' ? 'ok' : 452_673_384 },
    }));
    expect(row(/Helius HTTP/u)).toMatch(/OK, \d+ msslot 452673384/u);
    expect(row(/Helius WebSocket/u)).toContain('first event after');
    expect(row(/Helius WebSocket/u)).toContain('slot 452700000');
    const jupiter = row(/Jupiter/u);
    expect(jupiter).toContain('0.01 SOL → 1.174568 USDC (metis)');
    expect(jupiter).toContain(
      'x-ratelimit-remaining 58, x-ratelimit-current 2, x-ratelimit-reset 1790966971 (',
    );
    expect(document.body.innerHTML).not.toContain(HELIUS);
    expect(document.body.innerHTML).not.toContain(JUPITER);
  });

  it('devnet: Jupiter is skipped with a sentence and nothing is sent to it', async () => {
    const { row, calls } = await setup(
      (b) => ({
        status: 200,
        json: { jsonrpc: '2.0', id: b.id, result: b.method === 'getHealth' ? 'ok' : 5 },
      }),
      'devnet',
    );
    expect(row(/Helius HTTP/u)).toMatch(/OK, \d+ ms/u);
    expect(row(/Jupiter/u)).toContain('Skipped');
    expect(row(/Jupiter/u)).toContain('Jupiter works on Mainnet only');
    expect(screen.getByText('Network: Devnet')).toBeTruthy();
    expect(calls.map((c) => new URL(c.url).host)).toEqual([
      'devnet.helius-rpc.com',
      'devnet.helius-rpc.com',
    ]);
  });

  it('a rejected Helius key: English message in that row, the others still run', async () => {
    const { row } = await setup(() => ({ status: 401, json: { error: `bad key ${HELIUS}` } }));
    expect(row(/Helius HTTP/u)).toContain('Error');
    expect(row(/Helius HTTP/u)).toContain('The service rejected the API key (HTTP 401)');
    expect(row(/Jupiter/u)).toMatch(/^Jupiter.*OK/u);
    expect(document.body.innerHTML).not.toContain(HELIUS);
  });
});
