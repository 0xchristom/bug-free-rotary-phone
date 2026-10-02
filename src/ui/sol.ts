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

export type SolInput =
  | { readonly ok: true; readonly lamports: bigint }
  | { readonly ok: false; readonly message: string };

/** Max spend field: Polish message for each kind of mistake (the value is never echoed). */
export function parseSolAmount(text: string): SolInput {
  const t = text.trim();
  if (/^-/u.test(t)) return { ok: false, message: 'Kwota nie może być ujemna.' };
  if (/^\d+[.,]\d{10,}$/u.test(t)) {
    return { ok: false, message: 'Podaj najwyżej 9 miejsc po przecinku (1 lamport).' };
  }
  const lamports = parseSol(t);
  return lamports === null
    ? { ok: false, message: 'Podaj kwotę w SOL, np. 0,25.' }
    : { ok: true, lamports };
}

/** Token amount (raw u64) with its decimals → "1 234,5" style text with a decimal comma. */
export function formatUnits(amount: bigint, decimals: number): string {
  if (decimals === 0) return amount.toString();
  const base = 10n ** BigInt(decimals);
  const whole = amount / base;
  const fraction = (amount % base).toString().padStart(decimals, '0').replace(/0+$/u, '');
  return fraction === '' ? whole.toString() : `${whole.toString()},${fraction}`;
}
