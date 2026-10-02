import { LAMPORTS_PER_SOL } from '../core/settings.ts';

const SOL_DECIMALS = 9;

/** "0,015" or "0.015" → lamports; null if not a plain non-negative decimal with ≤ 9 places. */
export function parseSol(text: string): bigint | null {
  const match = /^(\d{1,10})(?:[.,](\d{1,9}))?$/u.exec(text.trim());
  if (!match) return null;
  const whole = BigInt(match[1] ?? '0');
  const fraction = BigInt((match[2] ?? '').padEnd(SOL_DECIMALS, '0'));
  return whole * LAMPORTS_PER_SOL + fraction;
}

/** Lamports → "0,015" (Polish decimal comma, no trailing zeros). */
export function formatSol(lamports: bigint): string {
  const whole = lamports / LAMPORTS_PER_SOL;
  const fraction = (lamports % LAMPORTS_PER_SOL)
    .toString()
    .padStart(SOL_DECIMALS, '0')
    .replace(/0+$/u, '');
  return fraction === '' ? whole.toString() : `${whole.toString()},${fraction}`;
}
