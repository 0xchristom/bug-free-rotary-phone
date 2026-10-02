/**
 * Wallet state machine of the executor (SPEC 3.5, BUNNDLY-21, D-029):
 * IDLE → QUEUED → QUOTING → SIGNING → SUBMITTED → CONFIRMED | FAILED | UNKNOWN | SKIPPED.
 * The table lists every allowed move; anything else is a programming error.
 */

export const WALLET_STATES = [
  'IDLE',
  'QUEUED',
  'QUOTING',
  'SIGNING',
  'SUBMITTED',
  'CONFIRMED',
  'FAILED',
  'UNKNOWN',
  'SKIPPED',
] as const;

export type WalletState = (typeof WALLET_STATES)[number];

/**
 * Allowed transitions. Back to QUEUED: a transient failure puts the wallet at the end of
 * the queue. UNKNOWN (sent, outcome not known) is left only after checking the chain
 * (BUNNDLY-23).
 */
export const TRANSITIONS: Readonly<Record<WalletState, readonly WalletState[]>> = {
  IDLE: ['QUEUED', 'SKIPPED'],
  QUEUED: ['QUOTING', 'SKIPPED'],
  QUOTING: ['SIGNING', 'QUEUED', 'SKIPPED', 'FAILED'],
  SIGNING: ['SUBMITTED', 'SKIPPED', 'FAILED'],
  SUBMITTED: ['CONFIRMED', 'QUEUED', 'FAILED', 'UNKNOWN'],
  UNKNOWN: ['CONFIRMED', 'QUEUED', 'FAILED'],
  CONFIRMED: [],
  FAILED: [],
  SKIPPED: [],
};

/** States a run can end in. UNKNOWN ends a run until BUNNDLY-23 resolves it. */
export const FINAL_STATES: ReadonlySet<WalletState> = new Set([
  'CONFIRMED',
  'FAILED',
  'UNKNOWN',
  'SKIPPED',
]);

export class IllegalTransitionError extends Error {
  override readonly name = 'IllegalTransitionError';
  constructor(from: WalletState, to: WalletState) {
    super(`Illegal wallet transition ${from} → ${to}`);
  }
}

export function assertTransition(from: WalletState, to: WalletState): void {
  if (!TRANSITIONS[from].includes(to)) throw new IllegalTransitionError(from, to);
}

/** Why a wallet was skipped. Always present on SKIPPED. */
export type SkipReason =
  /** Last known balance below max spend + reserve (checked before `/order`). */
  | 'INSUFFICIENT_SOL'
  /** No balance read yet, so the reserve cannot be checked. */
  | 'BALANCE_UNKNOWN'
  /** `/order` built no transaction: not enough funds. */
  | 'INSUFFICIENT_FUNDS'
  /** `/order` built no transaction: not enough SOL for the fee. */
  | 'INSUFFICIENT_SOL_FOR_GAS'
  /** DRY-RUN: signed, then thrown away; `/execute` is never called. */
  | 'DRY_RUN'
  /** STOP before this wallet's transaction was sent. */
  | 'STOPPED';

/** Why a wallet failed. Always present on FAILED, with a detail code when there is one. */
export type FailReason =
  /** `/order` failed in a way a retry does not fix (bad request, key, odd answer). */
  | 'ORDER_FAILED'
  /** The pre-sign checks refused the transaction (detail: the check problem). */
  | 'CHECK_FAILED'
  /** `/execute` refused the transaction for good (detail: the outcome). */
  | 'EXECUTE_FAILED'
  /** Transient failures used up all attempts (detail: the last one). */
  | 'MAX_ATTEMPTS';

/** Why the outcome is not known (detail: what happened to `/execute`). */
export type UnknownReason = 'EXECUTE_NO_ANSWER';

export type WalletReason =
  | { readonly kind: 'SKIPPED'; readonly code: SkipReason; readonly detail: string | null }
  | { readonly kind: 'FAILED'; readonly code: FailReason; readonly detail: string | null }
  | { readonly kind: 'UNKNOWN'; readonly code: UnknownReason; readonly detail: string | null };

export const SKIP_MESSAGES: Record<SkipReason, string> = {
  INSUFFICIENT_SOL: 'Za mało SOL: saldo jest mniejsze niż max spend plus rezerwa.',
  BALANCE_UNKNOWN: 'Saldo portfela nie zostało jeszcze odczytane.',
  INSUFFICIENT_FUNDS: 'Jupiter: za mało środków w portfelu.',
  INSUFFICIENT_SOL_FOR_GAS: 'Jupiter: za mało SOL na opłatę transakcyjną.',
  DRY_RUN: 'DRY-RUN: transakcja podpisana i odrzucona, nic nie zostało wysłane.',
  STOPPED: 'Zatrzymane przyciskiem STOP przed wysłaniem.',
};

export const FAIL_MESSAGES: Record<FailReason, string> = {
  ORDER_FAILED: 'Jupiter odrzucił zapytanie o zlecenie.',
  CHECK_FAILED: 'Transakcja nie przeszła kontroli przed podpisem.',
  EXECUTE_FAILED: 'Jupiter odrzucił transakcję.',
  MAX_ATTEMPTS: 'Wyczerpany limit prób.',
};

export const UNKNOWN_MESSAGES: Record<UnknownReason, string> = {
  EXECUTE_NO_ANSWER:
    'Transakcja została wysłana, ale wynik nie jest znany (brak odpowiedzi). Może jeszcze wylądować.',
};
