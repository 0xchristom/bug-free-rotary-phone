/**
 * One BUNNDLY-49 repetition: the creator makes a fresh DBC token in slot S0, the script
 * reacts when RPC first reports that transaction (`processed`), reads the pool, quotes and
 * sends one buy per fleet wallet at once, then reads every buy back from the chain.
 *
 * The buys are built with the BUNNDLY-47 module (`buildBuyInstructions`, the same
 * instructions the app's direct route signs, D-062) and signed here with the test wallets.
 * This measures the chain side (detection, quote, send, landing); the app's watcher and UI
 * stay for the browser run.
 */
import { getAddressDecoder } from '@solana/kit';
import {
  ActivationType,
  buildBuyInstructions,
  decodePoolConfig,
  decodeVirtualPool,
  quoteFromState,
  type DbcPoolState,
  type PoolConfig,
} from '../../src/direct/meteora-dbc/index.ts';
import {
  DevnetError,
  buyRow,
  dbcTokenAccounts,
  getTransaction,
  initializeDbcPool,
  newSeed,
  walletFromSeed,
  type BuyRow,
  type Devnet,
  type Wallet,
} from './lib.ts';

export interface CycleOptions {
  readonly config: string;
  readonly lamportsIn: bigint;
  readonly slippageBps: number;
  readonly computeUnitLimit: number;
  readonly computeUnitPriceMicroLamports: bigint;
}

export interface CycleRow extends BuyRow {
  /** Detection (first `processed` answer for the creation) to this buy's send, ms. */
  readonly detectToSentMs: number;
  /** This buy's send to its `confirmed` answer, ms. */
  readonly sentToConfirmedMs: number;
  readonly attempts: number;
  readonly quotedTokens: bigint;
  readonly maxSpend: bigint;
}

export interface CycleResult {
  readonly mint: string;
  readonly pool: string;
  readonly creation: string;
  readonly s0: number;
  /** Slot RPC reported when the script first saw the creation. */
  readonly detectedSlot: number;
  readonly creationSentToDetectMs: number;
  readonly detectToQuotedMs: number;
  readonly rows: readonly CycleRow[];
  readonly failures: readonly { readonly wallet: string; readonly error: string }[];
}

const decodeKey = (bytes: Uint8Array) => getAddressDecoder().decode(bytes);

async function accountData(d: Devnet, account: string): Promise<Uint8Array | null> {
  const { value } = await d.rpc.call<{ value: { data: [string, string] } | null }>(
    'getAccountInfo',
    [account, { encoding: 'base64', commitment: 'processed' }],
  );
  return value ? Uint8Array.from(Buffer.from(value.data[0], 'base64')) : null;
}

export async function readConfig(d: Devnet, config: string): Promise<PoolConfig> {
  const data = await accountData(d, config);
  if (!data) throw new DevnetError(`config ${config} not found`);
  return decodePoolConfig(data, decodeKey);
}

/** Highest lamports a buy may take from the wallet: amount, new token account, fees. */
export function maxSpendOf(o: CycleOptions, ataRent: bigint, signatures = 1): bigint {
  const priority =
    (BigInt(o.computeUnitLimit) * o.computeUnitPriceMicroLamports + 999_999n) / 1_000_000n;
  return o.lamportsIn + ataRent + 5_000n * BigInt(signatures) + priority;
}

/** Reads the pool of `mint` (processed), quotes and builds one wallet's buy. */
export async function buyInstructions(
  d: Devnet,
  payer: string,
  mint: string,
  config: PoolConfig,
  o: CycleOptions,
  slot: number,
) {
  const accounts = await dbcTokenAccounts(o.config, mint);
  let poolData: Uint8Array | null = null;
  for (let i = 0; i < 20 && poolData === null; i++) {
    poolData = await accountData(d, accounts.pool);
  }
  if (!poolData) throw new DevnetError(`pool ${accounts.pool} not readable`);
  const state: DbcPoolState = {
    address: accounts.pool,
    pool: decodeVirtualPool(poolData, decodeKey),
    config,
    baseTokenProgram: 'spl-token',
  };
  const point =
    config.activationType === ActivationType.Slot
      ? BigInt(slot)
      : BigInt(Math.floor(Date.now() / 1000));
  const quote = quoteFromState(state, o.lamportsIn, o.slippageBps, point);
  if (quote.kind !== 'ok') throw new DevnetError(`quote: ${quote.kind}`);
  const instructions = await buildBuyInstructions({
    payer,
    pool: accounts.pool,
    config: o.config,
    baseMint: mint,
    baseVault: accounts.baseVault,
    quoteVault: accounts.quoteVault,
    baseTokenProgram: 'spl-token',
    lamportsIn: o.lamportsIn,
    minimumAmountOut: quote.minimumAmountOut,
    computeUnitLimit: o.computeUnitLimit,
    computeUnitPriceMicroLamports: o.computeUnitPriceMicroLamports,
  });
  return {
    instructions,
    quoted: quote.quote.outputAmount,
    minimumAmountOut: quote.minimumAmountOut,
  };
}

export async function runCycle(
  d: Devnet,
  creator: Wallet,
  fleet: readonly Wallet[],
  config: PoolConfig,
  o: CycleOptions,
  ataRent: bigint,
): Promise<CycleResult> {
  const lifetime = await d.latestBlockhash();
  const mint = await walletFromSeed(newSeed());
  const accounts = await dbcTokenAccounts(o.config, mint.address);
  const create = await initializeDbcPool({
    config: o.config,
    creator: creator.address,
    baseMint: mint.address,
    payer: creator.address,
    name: 'Bunndly devnet test',
    symbol: 'BDT',
    uri: '',
  });
  const creation = await d.sendOnly([create], [creator, mint], lifetime);
  const detected = await d.waitFor(creation.signature, 'processed');

  let poolData: Uint8Array | null = null;
  for (let i = 0; i < 20 && poolData === null; i++) {
    poolData = await accountData(d, accounts.pool);
  }
  if (!poolData) throw new DevnetError(`pool ${accounts.pool} not readable after detection`);
  const state: DbcPoolState = {
    address: accounts.pool,
    pool: decodeVirtualPool(poolData, decodeKey),
    config,
    baseTokenProgram: 'spl-token',
  };
  const point =
    config.activationType === ActivationType.Slot
      ? BigInt(detected.slot)
      : BigInt(Math.floor(Date.now() / 1000));
  const quote = quoteFromState(state, o.lamportsIn, o.slippageBps, point);
  if (quote.kind !== 'ok') throw new DevnetError(`quote: ${quote.kind}`);
  const quotedAtMs = Date.now();

  const sent = await Promise.allSettled(
    fleet.map(async (w) => {
      const ixs = await buildBuyInstructions({
        payer: w.address,
        pool: accounts.pool,
        config: o.config,
        baseMint: mint.address,
        baseVault: accounts.baseVault,
        quoteVault: accounts.quoteVault,
        baseTokenProgram: 'spl-token',
        lamportsIn: o.lamportsIn,
        minimumAmountOut: quote.minimumAmountOut,
        computeUnitLimit: o.computeUnitLimit,
        computeUnitPriceMicroLamports: o.computeUnitPriceMicroLamports,
      });
      return d.sendOnly(ixs, [w], lifetime);
    }),
  );

  const outcomes = await d.waitForAll([
    creation.signature,
    ...sent.flatMap((r) => (r.status === 'fulfilled' ? [r.value.signature] : [])),
  ]);
  const creationLanded = outcomes.get(creation.signature);
  if (!creationLanded?.ok) {
    throw new DevnetError(`creation ${creation.signature}: ${creationLanded?.error ?? 'lost'}`);
  }
  const creationTx = await getTransaction(d.rpc, creation.signature);
  const s0 = creationTx?.slot ?? creationLanded.slot;
  const rows: CycleRow[] = [];
  const failures: { wallet: string; error: string }[] = [];
  const maxSpend = maxSpendOf(o, ataRent);
  for (const [i, r] of sent.entries()) {
    const wallet = fleet[i]?.address ?? '';
    if (r.status === 'rejected') {
      failures.push({ wallet, error: r.reason instanceof Error ? r.reason.message : 'failed' });
      continue;
    }
    const landed = outcomes.get(r.value.signature);
    if (!landed?.ok) {
      failures.push({ wallet, error: `${r.value.signature} ${landed?.error ?? 'lost'}` });
      continue;
    }
    const tx = await getTransaction(d.rpc, r.value.signature);
    if (!tx) {
      failures.push({ wallet, error: `${r.value.signature} not found` });
      continue;
    }
    rows.push({
      ...buyRow(wallet, mint.address, r.value.signature, s0, tx),
      detectToSentMs: r.value.sentAtMs - detected.atMs,
      sentToConfirmedMs: landed.atMs - r.value.sentAtMs,
      attempts: 1,
      quotedTokens: quote.quote.outputAmount,
      maxSpend,
    });
  }
  return {
    mint: mint.address,
    pool: accounts.pool,
    creation: creation.signature,
    s0,
    detectedSlot: detected.slot,
    creationSentToDetectMs: detected.atMs - creation.sentAtMs,
    detectToQuotedMs: quotedAtMs - detected.atMs,
    rows,
    failures,
  };
}
