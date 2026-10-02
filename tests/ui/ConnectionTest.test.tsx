// @vitest-environment jsdom
/** „Test połączeń” on the settings screen (BUNNDLY-16), real vault handler, mocked net. */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

const HELIUS = 'heliusKeyUiConn123';
const JUPITER = 'jupiterKeyUiConn456';

vi.setConfig({ testTimeout: 60_000 });

async function setup(helius: (body: { id: number; method: string }) => FetchReply) {
  const { fetch } = fakeFetch((call) =>
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
  const client = { request: (r: unknown, o?: object) => handler.handle(r, o) } as VaultClient;
  render(<App vault={client} storage={mockStorage().env} statusPollMs={60_000} />);
  const user = userEvent.setup();
  const nav = await screen.findByRole('navigation', {}, { timeout: 10_000 });
  await user.click(within(nav).getByRole('button', { name: 'Ustawienia' }));
  await user.click(await screen.findByRole('button', { name: 'Test połączeń' }));
  const table = await screen.findByRole('table', { name: 'Wyniki testu połączeń' });
  const row = (name: RegExp) =>
    within(table).getByRole('rowheader', { name }).closest('tr')?.textContent ?? '';
  return { row };
}

afterEach(cleanup);

describe('connection test in the settings', () => {
  it('shows OK, times, the quote and the rate limit headers; keys never reach the page', async () => {
    const { row } = await setup((b) => ({
      status: 200,
      json: { jsonrpc: '2.0', id: b.id, result: b.method === 'getHealth' ? 'ok' : 452_673_384 },
    }));
    expect(row(/Helius HTTP/u)).toMatch(/OK, \d+ msslot 452673384/u);
    expect(row(/Helius WebSocket/u)).toContain('pierwsze zdarzenie po');
    expect(row(/Helius WebSocket/u)).toContain('slot 452700000');
    const jupiter = row(/Jupiter/u);
    expect(jupiter).toContain('0,01 SOL → 1,174568 USDC (metis)');
    expect(jupiter).toContain(
      'x-ratelimit-remaining 58, x-ratelimit-current 2, x-ratelimit-reset 1790966971 (',
    );
    expect(document.body.innerHTML).not.toContain(HELIUS);
    expect(document.body.innerHTML).not.toContain(JUPITER);
  });

  it('a rejected Helius key: Polish message in that row, the others still run', async () => {
    const { row } = await setup(() => ({ status: 401, json: { error: `bad key ${HELIUS}` } }));
    expect(row(/Helius HTTP/u)).toContain('Błąd');
    expect(row(/Helius HTTP/u)).toContain('Usługa odrzuciła klucz API (HTTP 401)');
    expect(row(/Jupiter/u)).toMatch(/^Jupiter.*OK/u);
    expect(document.body.innerHTML).not.toContain(HELIUS);
  });
});
