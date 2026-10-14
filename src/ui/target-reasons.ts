import type { TargetCheck } from './CommandBar.tsx';

export const CHECKING_TARGET = 'Checking the target…';

/**
 * Why a command that needs one kind of target cannot run with the target field as it is
 * (BUNNDLY-79): the field is empty, still checking, holds no address (the field's message
 * alone), could not be read (the field's message after "Could not check the target:"), or
 * holds the other kind of address. Called only when the needed target is missing.
 */
export function targetReason(
  check: TargetCheck,
  texts: { readonly empty: string; readonly otherKind: string },
): string {
  switch (check.kind) {
    case 'empty':
      return texts.empty;
    case 'checking':
      return CHECKING_TARGET;
    case 'error':
      return check.cause === 'format'
        ? check.message
        : `Could not check the target: ${check.message}`;
    case 'done':
      return texts.otherKind;
  }
}

export const BUY_TARGET = {
  empty: 'Paste a token mint first.',
  otherKind:
    'BUY needs a token: arm the watcher and wait for this creator’s token, or paste a mint.',
} as const;

export const SELL_TARGET = {
  empty: 'Paste the mint of the token to sell.',
  otherKind: 'SELL needs a token mint, not a creator wallet.',
} as const;

export const ARM_TARGET = {
  empty: 'Paste a creator wallet first.',
  otherKind: 'ARM needs a creator wallet, not a token.',
} as const;
