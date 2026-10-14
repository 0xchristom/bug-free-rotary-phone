/**
 * The USDC mint account as getMultipleAccounts returns it (base64), copied from
 * tests/fixtures/token-accounts.mainnet.json. RPC fakes answer it for the addresses a test
 * buys, so the worker's target check (BUNNDLY-59) reads them as token mints.
 */
export const MINT_ACCOUNT = {
  lamports: 535_325_803_497n,
  owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  data: [
    'AQAAAJj+huiNm+Lqi8HMpIeLKYjCQPUrhCS/tA7Rot3LXhmb8nPKGK0THgAGAQEAAABicKqKWcWUBbRShshncubNEm6bil06OFNtN/e0FOi2Zw==',
    'base64',
  ],
  executable: false,
  rentEpoch: 0n,
  space: 82n,
} as const;
