import type { Explorer } from '../core/settings.ts';

/** Transaction pages of the explorers in Settings (SPEC 3.3). */
const TX_URL: Record<Explorer, string> = {
  solscan: 'https://solscan.io/tx/',
  orb: 'https://orb.helius.dev/tx/',
  'solana-explorer': 'https://explorer.solana.com/tx/',
};

/** A base58 signature of 64 bytes is 87 or 88 characters. */
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/u;

/** Link to the transaction, or null for anything that is not a plain signature. */
export function transactionUrl(explorer: Explorer, signature: string): string | null {
  return SIGNATURE.test(signature) ? `${TX_URL[explorer]}${signature}` : null;
}
