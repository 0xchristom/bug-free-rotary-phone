/**
 * The network module (BUNNDLY-44, D-041). Expected addresses are copied from the
 * documentation, read 2026-10-12:
 * - Helius: https://www.helius.dev/docs/api-reference/endpoints
 *   (mainnet.helius-rpc.com and devnet.helius-rpc.com, https and wss, `?api-key=`)
 * - public RPC: https://solana.com/docs/references/clusters
 *   (api.mainnet.solana.com, api.devnet.solana.com)
 * - Orb: https://www.helius.dev/docs/orb (orbmarkets.io, `?cluster=devnet`)
 * Solscan and Solana Explorer take the same `?cluster=devnet` query.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NETWORK,
  EXPLORERS,
  NETWORKS,
  NETWORK_LABELS,
  addressUrl,
  buyRouteOf,
  endpointNetwork,
  heliusRpcUrl,
  heliusWsUrl,
  parseNetwork,
  publicRpcUrl,
  transactionUrl,
} from '../../src/core/network.ts';

const SIG = '5'.repeat(88);
const ADDRESS = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';

describe('addresses per network', () => {
  it('mainnet: Helius HTTP and WebSocket, no public RPC (403 to a page, D-057)', () => {
    expect(heliusRpcUrl('mainnet', 'abc-123')).toBe(
      'https://mainnet.helius-rpc.com/?api-key=abc-123',
    );
    expect(heliusWsUrl('mainnet', 'abc-123')).toBe('wss://mainnet.helius-rpc.com/?api-key=abc-123');
    expect(publicRpcUrl('mainnet')).toBeNull();
  });

  it('devnet: Helius HTTP and WebSocket, public RPC', () => {
    expect(heliusRpcUrl('devnet', 'abc-123')).toBe(
      'https://devnet.helius-rpc.com/?api-key=abc-123',
    );
    expect(heliusWsUrl('devnet', 'abc-123')).toBe('wss://devnet.helius-rpc.com/?api-key=abc-123');
    expect(publicRpcUrl('devnet')).toBe('https://api.devnet.solana.com');
  });

  it('the key is escaped in the query', () => {
    expect(heliusRpcUrl('devnet', 'a&b')).toBe('https://devnet.helius-rpc.com/?api-key=a%26b');
  });

  it('a custom endpoint belongs to devnet only on the devnet host', () => {
    expect(endpointNetwork('https://devnet.helius-rpc.com/?api-key=x')).toBe('devnet');
    expect(endpointNetwork('wss://DEVNET.helius-rpc.com/?api-key=x')).toBe('devnet');
    expect(endpointNetwork('https://mainnet.helius-rpc.com/?api-key=x')).toBe('mainnet');
    expect(endpointNetwork('https://staked.helius-rpc.com/?api-key=x')).toBe('mainnet');
    expect(endpointNetwork('not a url')).toBeNull();
  });

  it('no other module in src names a network host', () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else files.push(path);
      }
    };
    walk('src');
    const naming = files
      .filter((f) =>
        /(mainnet|devnet)\.|solscan\.io|orbmarkets\.io|explorer\.solana/u.test(
          readFileSync(f, 'utf8'),
        ),
      )
      .map((f) => relative('.', f).replaceAll('\\', '/'));
    expect(naming).toEqual(['src/core/network.ts']);
  });
});

describe('the saved choice', () => {
  it('mainnet is the default', () => {
    expect(DEFAULT_NETWORK).toBe('mainnet');
  });

  it.each([undefined, null, '', 'testnet', 'Devnet', 'MAINNET', 1, {}, ['devnet']])(
    '%j reads as mainnet',
    (value) => {
      expect(parseNetwork(value)).toBe('mainnet');
    },
  );

  it('the two known values read as themselves', () => {
    expect(NETWORKS.map((n) => parseNetwork(n))).toEqual(['mainnet', 'devnet']);
  });

  it('labels are exactly Mainnet and Devnet', () => {
    expect(NETWORK_LABELS).toEqual({ mainnet: 'Mainnet', devnet: 'Devnet' });
  });
});

describe('buy route', () => {
  it('Jupiter on mainnet, none on devnet', () => {
    expect(buyRouteOf('mainnet')).toBe('jupiter');
    expect(buyRouteOf('devnet')).toBe('direct'); // Meteora DBC, BUNNDLY-48
  });
});

describe('explorer links', () => {
  it('mainnet: plain links', () => {
    expect(transactionUrl('solscan', 'mainnet', SIG)).toBe(`https://solscan.io/tx/${SIG}`);
    expect(transactionUrl('orb', 'mainnet', SIG)).toBe(`https://orbmarkets.io/tx/${SIG}`);
    expect(transactionUrl('solana-explorer', 'mainnet', SIG)).toBe(
      `https://explorer.solana.com/tx/${SIG}`,
    );
    expect(addressUrl('solscan', 'mainnet', ADDRESS)).toBe(`https://solscan.io/account/${ADDRESS}`);
    expect(addressUrl('orb', 'mainnet', ADDRESS)).toBe(`https://orbmarkets.io/address/${ADDRESS}`);
    expect(addressUrl('solana-explorer', 'mainnet', ADDRESS)).toBe(
      `https://explorer.solana.com/address/${ADDRESS}`,
    );
  });

  it('devnet: every explorer gets the devnet cluster, for transactions and addresses', () => {
    expect(transactionUrl('solscan', 'devnet', SIG)).toBe(
      `https://solscan.io/tx/${SIG}?cluster=devnet`,
    );
    expect(transactionUrl('orb', 'devnet', SIG)).toBe(
      `https://orbmarkets.io/tx/${SIG}?cluster=devnet`,
    );
    expect(transactionUrl('solana-explorer', 'devnet', SIG)).toBe(
      `https://explorer.solana.com/tx/${SIG}?cluster=devnet`,
    );
    for (const explorer of EXPLORERS) {
      expect(addressUrl(explorer, 'devnet', ADDRESS)).toMatch(
        new RegExp(`/${ADDRESS}\\?cluster=devnet$`, 'u'),
      );
    }
  });

  it('anything that is not a plain signature or address gives no link', () => {
    for (const network of NETWORKS) {
      expect(transactionUrl('solscan', network, 'javascript:alert(1)')).toBeNull();
      expect(transactionUrl('solscan', network, `${SIG}?x=1`)).toBeNull();
      expect(addressUrl('solscan', network, `${ADDRESS}/../x`)).toBeNull();
      expect(addressUrl('solscan', network, '')).toBeNull();
    }
  });
});
