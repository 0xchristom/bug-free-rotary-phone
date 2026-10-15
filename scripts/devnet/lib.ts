/**
 * Devnet tooling for BUNNDLY-49: a fresh Meteora DBC token, a funded test fleet and slot
 * reads from RPC. Runs in Node only, never in the app.
 *
 * Signing rules (CLAUDE.md, "Bramki dla człowieka"; BUNNDLY-49):
 * - the devnet main wallet key is read from the path in BUNNDLY_DEVNET_KEYPAIR; neither
 *   the path nor the key is in the repo;
 * - nothing is signed before `getGenesisHash` returned the devnet hash
 *   (`openDevnet` is the only way to get a sender);
 * - keys and file contents never reach output or error messages; only public addresses
 *   and signatures are printed.
 *
 * `initialize_virtual_pool_with_spl_token`: accounts, discriminator and arguments from IDL
 * `dynamic_bonding_curve` 0.2.2 in MeteoraAg/dynamic-bonding-curve-sdk (MIT), commit
 * a8e5fedf1cc62e488da477a19ae3c6ad9a707f80, packages/dynamic-bonding-curve/src/idl.
 */
import { readFile } from 'node:fs/promises';
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createKeyPairFromBytes,
  createKeyPairFromPrivateKeyBytes,
  createTransactionMessage,
  getAddressEncoder,
  getAddressFromPublicKey,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
  type Address,
  type Instruction,
} from '@solana/kit';
import { SYSTEM_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from '../../src/chain/tokens.ts';
import {
  DBC_PROGRAM_ADDRESS,
  WSOL_MINT,
  findDbcEventAuthority,
  findDbcPoolAddress,
  findDbcPoolAuthority,
} from '../../src/direct/meteora-dbc/index.ts';

/** Devnet genesis hash, read from RPC 12.10.2026 16:05 UTC (BUNNDLY-49, Andy). */
export const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const DEVNET_RPC_URL = 'https://api.devnet.solana.com';
export const KEYPAIR_ENV = 'BUNNDLY_DEVNET_KEYPAIR';
/** Metaplex Token Metadata program (IDL: fixed address of `metadata_program`). */
export const METADATA_PROGRAM_ADDRESS = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
export const INITIALIZE_POOL_SPL_DISCRIMINATOR = [140, 85, 215, 176, 102, 54, 104, 79] as const;

export class DevnetError extends Error {
  override name = 'DevnetError';
}

// ---------------------------------------------------------------- RPC

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface Rpc {
  call<T>(method: string, params?: unknown[]): Promise<T>;
}

/** Plain JSON-RPC over fetch. Retries HTTP 429 (devnet: 100 requests per 10 s per IP). */
export function createRpc(url: string, fetchFn: Fetch = fetch): Rpc {
  let id = 0;
  return {
    async call<T>(method: string, params: unknown[] = []): Promise<T> {
      for (let attempt = 0; ; attempt++) {
        const res = await fetchFn(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        });
        if (res.status === 429 && attempt < 5) {
          await sleep(500 * (attempt + 1));
          continue;
        }
        if (!res.ok) throw new DevnetError(`${method}: HTTP ${String(res.status)}`);
        const body = (await res.json()) as { result?: T; error?: { message?: string } };
        if (body.error) throw new DevnetError(`${method}: ${body.error.message ?? 'RPC error'}`);
        return body.result as T;
      }
    },
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- keys

export interface Wallet {
  readonly address: Address;
  readonly keyPair: Awaited<ReturnType<typeof createKeyPairFromBytes>>;
}

/** Solana CLI keypair file (JSON array of 64 bytes). Errors never quote the file. */
export async function loadKeypairFile(path: string | undefined): Promise<Wallet> {
  if (!path) throw new DevnetError(`${KEYPAIR_ENV} is not set`);
  let bytes: Uint8Array;
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 64 ||
      !parsed.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)
    ) {
      throw new Error('shape');
    }
    bytes = Uint8Array.from(parsed as number[]);
  } catch {
    throw new DevnetError(`the file in ${KEYPAIR_ENV} is not a 64-byte Solana CLI keypair`);
  }
  try {
    const keyPair = await createKeyPairFromBytes(bytes);
    return { address: await getAddressFromPublicKey(keyPair.publicKey), keyPair };
  } catch {
    throw new DevnetError(`the file in ${KEYPAIR_ENV} holds an inconsistent keypair`);
  } finally {
    bytes.fill(0);
  }
}

/** Test wallet from a 32-byte seed (the seed is what the state file keeps). */
export async function walletFromSeed(seed: Uint8Array): Promise<Wallet> {
  const keyPair = await createKeyPairFromPrivateKeyBytes(seed);
  return { address: await getAddressFromPublicKey(keyPair.publicKey), keyPair };
}

export function newSeed(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

// ---------------------------------------------------------------- guard and sending

export interface Devnet {
  readonly rpc: Rpc;
  /** Signs with every wallet in `signers` (first = fee payer), sends, waits for confirmation. */
  send(instructions: readonly Instruction[], signers: readonly Wallet[]): Promise<Sent>;
  /** Signs and sends once (no preflight, no RPC retries) without waiting. */
  sendOnly(
    instructions: readonly Instruction[],
    signers: readonly Wallet[],
    lifetime?: Lifetime,
  ): Promise<SentOnly>;
  waitFor(signature: string, level: 'processed' | 'confirmed', timeoutMs?: number): Promise<Landed>;
  latestBlockhash(): Promise<Lifetime>;
  /** Same transaction, simulated without signatures (sigVerify false). */
  simulate(instructions: readonly Instruction[], feePayer: Address): Promise<Simulation>;
}

export interface Lifetime {
  readonly blockhash: string;
  readonly lastValidBlockHeight: number;
}

export interface Landed {
  readonly slot: number;
  readonly atMs: number;
}

export interface SentOnly {
  readonly signature: string;
  readonly signedAtMs: number;
  readonly sentAtMs: number;
}

export interface Sent {
  readonly signature: string;
  readonly slot: number;
  readonly sentAtMs: number;
  readonly confirmedAtMs: number;
}

export interface Simulation {
  readonly err: unknown;
  readonly logs: readonly string[];
  readonly unitsConsumed?: number;
}

/**
 * The only way to a sender: checks `getGenesisHash` first and refuses anything that is
 * not devnet, before any transaction is built or signed.
 */
export async function openDevnet(rpc: Rpc): Promise<Devnet> {
  const genesis = await rpc.call<string>('getGenesisHash');
  if (genesis !== DEVNET_GENESIS_HASH) {
    throw new DevnetError(`refusing to work: genesis hash ${genesis} is not devnet`);
  }

  async function compile(
    instructions: readonly Instruction[],
    feePayer: Address,
    lifetime?: Lifetime,
  ) {
    const value = lifetime ?? (await latestBlockhash());
    return compileTransaction(
      pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayer(feePayer, m),
        (m) =>
          setTransactionMessageLifetimeUsingBlockhash(
            {
              blockhash: blockhash(value.blockhash),
              lastValidBlockHeight: BigInt(value.lastValidBlockHeight),
            },
            m,
          ),
        (m) => appendTransactionMessageInstructions(instructions, m),
      ),
    );
  }

  async function latestBlockhash(): Promise<Lifetime> {
    const { value } = await rpc.call<{ value: Lifetime }>('getLatestBlockhash', [
      { commitment: 'confirmed' },
    ]);
    return value;
  }

  return {
    rpc,
    latestBlockhash,
    async sendOnly(instructions, signers, lifetime) {
      const payer = signers[0];
      if (!payer) throw new DevnetError('no fee payer');
      const signed = await signTransaction(
        signers.map((s) => s.keyPair),
        await compile(instructions, payer.address, lifetime),
      );
      const signature = getSignatureFromTransaction(signed);
      const signedAtMs = Date.now();
      // Preflight off: the buy goes out in the same moment (the app's live mode simulates
      // nothing before sending either, D-062).
      await rpc.call<string>('sendTransaction', [
        getBase64EncodedWireTransaction(signed),
        { encoding: 'base64', skipPreflight: true, maxRetries: 0 },
      ]);
      return { signature, signedAtMs, sentAtMs: Date.now() };
    },
    async waitFor(signature, level, timeoutMs = 60_000) {
      return waitForConfirmation(rpc, signature, level, timeoutMs);
    },
    async send(instructions, signers) {
      const payer = signers[0];
      if (!payer) throw new DevnetError('no fee payer');
      const signed = await signTransaction(
        signers.map((s) => s.keyPair),
        await compile(instructions, payer.address),
      );
      const signature = getSignatureFromTransaction(signed);
      const sentAtMs = Date.now();
      await rpc.call<string>('sendTransaction', [
        getBase64EncodedWireTransaction(signed),
        { encoding: 'base64', preflightCommitment: 'confirmed' },
      ]);
      const confirmed = await waitForConfirmation(rpc, signature);
      return { signature, slot: confirmed.slot, sentAtMs, confirmedAtMs: Date.now() };
    },
    async simulate(instructions, feePayer) {
      const tx = await compile(instructions, feePayer);
      const { value } = await rpc.call<{
        value: { err: unknown; logs: string[] | null; unitsConsumed?: number };
      }>('simulateTransaction', [
        getBase64EncodedWireTransaction(tx),
        { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true },
      ]);
      return {
        err: value.err,
        logs: value.logs ?? [],
        ...(value.unitsConsumed === undefined ? {} : { unitsConsumed: value.unitsConsumed }),
      };
    },
  };
}

async function waitForConfirmation(
  rpc: Rpc,
  signature: string,
  level: 'processed' | 'confirmed' = 'confirmed',
  timeoutMs = 60_000,
): Promise<Landed> {
  const deadline = Date.now() + timeoutMs;
  // 'processed' is polled faster: it is the detection moment of the cycle (BUNNDLY-49).
  const pause = level === 'processed' ? 150 : 400;
  while (Date.now() < deadline) {
    const { value } = await rpc.call<{
      value: ({ slot: number; err: unknown; confirmationStatus: string | null } | null)[];
    }>('getSignatureStatuses', [[signature]]);
    const status = value[0];
    if (status?.err) throw new DevnetError(`${signature} failed: ${JSON.stringify(status.err)}`);
    if (status && (level === 'processed' || status.confirmationStatus !== 'processed')) {
      return { slot: status.slot, atMs: Date.now() };
    }
    await sleep(pause);
  }
  throw new DevnetError(`${signature} not ${level} within ${String(timeoutMs / 1000)} s`);
}

// ---------------------------------------------------------------- instructions

const ro = (a: string) => ({ address: address(a), role: AccountRole.READONLY });
const w = (a: string) => ({ address: address(a), role: AccountRole.WRITABLE });
const rs = (a: string) => ({ address: address(a), role: AccountRole.READONLY_SIGNER });
const ws = (a: string) => ({ address: address(a), role: AccountRole.WRITABLE_SIGNER });

/** System Program `Transfer` = 2 (u32 tag, u64 lamports). */
export function transfer(from: string, to: string, lamports: bigint): Instruction {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, lamports, true);
  return { programAddress: address(SYSTEM_PROGRAM_ADDRESS), accounts: [ws(from), w(to)], data };
}

/** Borsh string: u32 little-endian byte length, then UTF-8. */
export function borshString(value: string): Uint8Array {
  const bytes = new TextEncoder().encode(value);
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length, true);
  out.set(bytes, 4);
  return out;
}

export interface NewDbcToken {
  readonly config: string;
  readonly creator: string;
  readonly baseMint: string;
  readonly payer: string;
  readonly name: string;
  readonly symbol: string;
  readonly uri: string;
}

export interface NewDbcTokenAccounts {
  readonly pool: Address;
  readonly baseVault: Address;
  readonly quoteVault: Address;
  readonly metadata: Address;
}

export async function dbcTokenAccounts(
  config: string,
  baseMint: string,
): Promise<NewDbcTokenAccounts> {
  const enc = getAddressEncoder();
  const pool = await findDbcPoolAddress(config, baseMint, WSOL_MINT);
  const vault = async (mint: string) =>
    (
      await getProgramDerivedAddress({
        programAddress: address(DBC_PROGRAM_ADDRESS),
        seeds: ['token_vault', enc.encode(address(mint)), enc.encode(pool)],
      })
    )[0];
  const [metadata] = await getProgramDerivedAddress({
    programAddress: address(METADATA_PROGRAM_ADDRESS),
    seeds: [
      'metadata',
      enc.encode(address(METADATA_PROGRAM_ADDRESS)),
      enc.encode(address(baseMint)),
    ],
  });
  return { pool, baseVault: await vault(baseMint), quoteVault: await vault(WSOL_MINT), metadata };
}

/** `initialize_virtual_pool_with_spl_token`, accounts in IDL order. */
export async function initializeDbcPool(p: NewDbcToken): Promise<Instruction> {
  const a = await dbcTokenAccounts(p.config, p.baseMint);
  const [poolAuthority, eventAuthority] = await Promise.all([
    findDbcPoolAuthority(),
    findDbcEventAuthority(),
  ]);
  const args = [borshString(p.name), borshString(p.symbol), borshString(p.uri)];
  const data = new Uint8Array(8 + args.reduce((n, b) => n + b.length, 0));
  data.set(INITIALIZE_POOL_SPL_DISCRIMINATOR, 0);
  let at = 8;
  for (const b of args) {
    data.set(b, at);
    at += b.length;
  }
  return {
    programAddress: address(DBC_PROGRAM_ADDRESS),
    accounts: [
      ro(p.config),
      ro(poolAuthority),
      rs(p.creator),
      ws(p.baseMint),
      ro(WSOL_MINT),
      w(a.pool),
      w(a.baseVault),
      w(a.quoteVault),
      w(a.metadata),
      ro(METADATA_PROGRAM_ADDRESS),
      ws(p.payer),
      ro(TOKEN_PROGRAM_ADDRESS),
      ro(TOKEN_PROGRAM_ADDRESS),
      ro(SYSTEM_PROGRAM_ADDRESS),
      ro(eventAuthority),
      ro(DBC_PROGRAM_ADDRESS),
    ],
    data,
  };
}

// ---------------------------------------------------------------- chain reads

interface TokenBalance {
  readonly accountIndex: number;
  readonly mint: string;
  readonly owner?: string;
  readonly uiTokenAmount: { readonly amount: string };
}

export interface ChainTx {
  readonly slot: number;
  readonly blockTime: number | null;
  readonly transaction: { readonly message: { readonly accountKeys: readonly string[] } };
  readonly meta: {
    readonly err: unknown;
    readonly fee: number;
    readonly preBalances: readonly number[];
    readonly postBalances: readonly number[];
    readonly preTokenBalances?: readonly TokenBalance[];
    readonly postTokenBalances?: readonly TokenBalance[];
    readonly loadedAddresses?: {
      readonly writable: readonly string[];
      readonly readonly: readonly string[];
    };
  };
}

export function getTransaction(rpc: Rpc, signature: string): Promise<ChainTx | null> {
  return rpc.call<ChainTx | null>('getTransaction', [
    signature,
    { encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
  ]);
}

export interface BuyRow {
  readonly wallet: string;
  readonly signature: string;
  readonly slot: number;
  readonly deltaS0: number;
  readonly ok: boolean;
  /** Lamports that left the wallet in this transaction (fee and rent included). */
  readonly solSpent: bigint;
  readonly fee: bigint;
  /** Token balance change of the wallet for the mint, smallest units. */
  readonly tokensReceived: bigint;
}

/** One buy as the chain recorded it, for `wallet` and `mint`, relative to slot S0. */
export function buyRow(
  wallet: string,
  mint: string,
  signature: string,
  s0: number,
  tx: ChainTx,
): BuyRow {
  const keys = [
    ...tx.transaction.message.accountKeys,
    ...(tx.meta.loadedAddresses?.writable ?? []),
    ...(tx.meta.loadedAddresses?.readonly ?? []),
  ];
  const i = keys.indexOf(wallet);
  const solSpent =
    i < 0 ? 0n : BigInt(tx.meta.preBalances[i] ?? 0) - BigInt(tx.meta.postBalances[i] ?? 0);
  const amount = (list: readonly TokenBalance[] | undefined) =>
    (list ?? [])
      .filter((b) => b.mint === mint && b.owner === wallet)
      .reduce((n, b) => n + BigInt(b.uiTokenAmount.amount), 0n);
  return {
    wallet,
    signature,
    slot: tx.slot,
    deltaS0: tx.slot - s0,
    ok: tx.meta.err === null,
    solSpent,
    fee: BigInt(tx.meta.fee),
    tokensReceived: amount(tx.meta.postTokenBalances) - amount(tx.meta.preTokenBalances),
  };
}
