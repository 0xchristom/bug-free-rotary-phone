/**
 * What each run mode does, in one sentence. One wording for the buy panel and for the mode
 * chip in the top bar, so the two can never say different things (SPEC 7: DRY-RUN asks for
 * real prices and signs, it only never sends).
 */
export const DRY_RUN_NOTE =
  'DRY-RUN: real price requests and signatures, but no transaction will be sent.';
export const LIVE_NOTE =
  'Live mode: a buy sends real transactions and spends SOL from the wallets.';
