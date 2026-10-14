/**
 * The network the fleet works on (BUNNDLY-44, D-041): the single place that knows a
 * network's addresses. Helius RPC and WebSocket, the public fallback RPC, the explorer
 * links and the way a buy is routed are all chosen from here; no other module names a
 * network host. Dependency-free, shared by the vault worker and the UI.
 * Mainnet has no public fallback: api.mainnet.solana.com answers 403 to requests from a
 * page (D-057).
 *
 * Sources, read 2026-10-12:
 * - Helius endpoints: https://www.helius.dev/docs/api-reference/endpoints
 * - public RPC: https://solana.com/docs/references/clusters
 * - Orb links and `?cluster=devnet`: https://www.helius.dev/docs/orb
 */

export const NETWORKS = ['mainnet', 'devnet'] as const;
export type Network = (typeof NETWORKS)[number];

export const DEFAULT_NETWORK: Network = 'mainnet';

/** The only names shown in the UI. */
export const NETWORK_LABELS: Record<Network, string> = {
  mainnet: 'Mainnet',
  devnet: 'Devnet',
};

/** Anything that is not a known network reads as mainnet (old files, old log entries). */
export function parseNetwork(value: unknown): Network {
  return NETWORKS.find((n) => n === value) ?? DEFAULT_NETWORK;
}

/**
 * How a buy reaches the chain. Jupiter's Swap API has no devnet (its program does not
 * exist there), so devnet buys directly from the Meteora DBC curve (BUNNDLY-48,
 * `src/direct/route.ts`). Mainnet stays on Jupiter: the direct route is off there until a
 * separate test and the owner's consent (SPEC 2.2).
 */
export type BuyRoute = 'jupiter' | 'direct';

interface NetworkConfig {
  readonly heliusHost: string;
  /** Null where the public RPC refuses requests from a page (mainnet, D-057). */
  readonly publicRpcUrl: string | null;
  /** Query added to explorer links; empty on mainnet. */
  readonly explorerQuery: string;
  readonly buyRoute: BuyRoute | null;
}

/**
 * The only domain allowed for custom Helius endpoints: the CSP (SPEC 6.4) lets the app
 * connect only to Helius, api.jup.ag and the fallback RPC, so any other host would fail
 * silently in the production build.
 */
export const HELIUS_DOMAIN = 'helius-rpc.com';

const CONFIG: Record<Network, NetworkConfig> = {
  mainnet: {
    heliusHost: `mainnet.${HELIUS_DOMAIN}`,
    publicRpcUrl: null,
    explorerQuery: '',
    buyRoute: 'jupiter',
  },
  devnet: {
    heliusHost: `devnet.${HELIUS_DOMAIN}`,
    publicRpcUrl: 'https://api.devnet.solana.com',
    explorerQuery: '?cluster=devnet',
    buyRoute: 'direct',
  },
};

/**
 * Devnet's genesis hash, read with `getGenesisHash` from api.devnet.solana.com on
 * 2026-10-15. Whatever signs on devnet (the direct route, scripts/fund-devnet.ts) checks
 * the RPC against it first and refuses any other network.
 */
export const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

export function buyRouteOf(network: Network): BuyRoute | null {
  return CONFIG[network].buyRoute;
}

/** One sentence for the UI where buying is switched off on the network. */
export const NO_BUY_ROUTE_MESSAGE =
  'Buying and the watcher are off on this network: it has no buy route.';

export function heliusHost(network: Network): string {
  return CONFIG[network].heliusHost;
}

/** Per Helius docs: the key goes in the `api-key` query parameter. */
export function heliusRpcUrl(network: Network, apiKey: string): string {
  return `https://${heliusHost(network)}/?api-key=${encodeURIComponent(apiKey)}`;
}

export function heliusWsUrl(network: Network, apiKey: string): string {
  return `wss://${heliusHost(network)}/?api-key=${encodeURIComponent(apiKey)}`;
}

/**
 * Public RPC of the network, used only for reads and only after Helius failed (D-020).
 * Null on mainnet: it answers 403 to requests from a page (D-057).
 */
export function publicRpcUrl(network: Network): string | null {
  return CONFIG[network].publicRpcUrl;
}

/**
 * The network a custom Helius endpoint belongs to, by its host: the devnet host is devnet,
 * every other Helius host (the shared mainnet one, dedicated nodes) is mainnet. Null for a
 * URL that does not parse.
 */
export function endpointNetwork(url: string): Network | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  return host === CONFIG.devnet.heliusHost ? 'devnet' : 'mainnet';
}

export const EXPLORERS = ['solscan', 'orb', 'solana-explorer'] as const;
export type Explorer = (typeof EXPLORERS)[number];

const EXPLORER_BASE: Record<Explorer, { readonly tx: string; readonly address: string }> = {
  solscan: { tx: 'https://solscan.io/tx/', address: 'https://solscan.io/account/' },
  orb: { tx: 'https://orbmarkets.io/tx/', address: 'https://orbmarkets.io/address/' },
  'solana-explorer': {
    tx: 'https://explorer.solana.com/tx/',
    address: 'https://explorer.solana.com/address/',
  },
};

/** A base58 signature of 64 bytes is 87 or 88 characters. */
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/u;
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/u;

/** Link to the transaction, or null for anything that is not a plain signature. */
export function transactionUrl(
  explorer: Explorer,
  network: Network,
  signature: string,
): string | null {
  if (!SIGNATURE.test(signature)) return null;
  return `${EXPLORER_BASE[explorer].tx}${signature}${CONFIG[network].explorerQuery}`;
}

/** Link to the account, or null for anything that is not a plain address. */
export function addressUrl(explorer: Explorer, network: Network, address: string): string | null {
  if (!ADDRESS.test(address)) return null;
  return `${EXPLORER_BASE[explorer].address}${address}${CONFIG[network].explorerQuery}`;
}
