/**
 * BUNNDLY-49 devnet CLI (README, "Devnet: test floty na DBC"). Usage:
 *
 *   node scripts/devnet/run.ts <command> [--flag value]...
 *
 *   balance                         main wallet address and balance
 *   simulate-token                  simulate creating a DBC token (no signature, nothing sent)
 *   fund --wallets 5 --sol 0.05     generate test wallets + a creator, fund them from main
 *   create-token                    the creator creates a fresh DBC token; prints S0
 *   report --mint M --s0 SIG [--max-spend-lamports L] [--wallets a,b]
 *                                   buys of M per wallet, read from RPC, with slot - S0
 *   refund                          every test wallet sends its SOL back to main
 *
 * Environment: BUNNDLY_DEVNET_KEYPAIR (path to the main wallet keypair file),
 * BUNNDLY_DEVNET_STATE (path to a JSON file outside the repo that keeps test wallet seeds),
 * BUNNDLY_DEVNET_RPC (optional, default the public devnet RPC).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { getBase58Decoder, getBase58Encoder, type Address } from '@solana/kit';
import {
  DEVNET_RPC_URL,
  DevnetError,
  KEYPAIR_ENV,
  buyRow,
  createRpc,
  dbcTokenAccounts,
  getTransaction,
  initializeDbcPool,
  loadKeypairFile,
  newSeed,
  openDevnet,
  transfer,
  walletFromSeed,
  type BuyRow,
  type Devnet,
  type Wallet,
} from './lib.ts';

/** Devnet DBC config from the BUNNDLY-47 fixture: quote WSOL, SPL token, fee in SOL. */
const DEFAULT_CONFIG = 'AkKLsP5gRZ6NopNyDmwPEr7z9Bwwrao8irCUZ9Rx3J7D';
const STATE_ENV = 'BUNNDLY_DEVNET_STATE';
const FEE_LAMPORTS = 5_000n;

interface State {
  readonly creator: string;
  readonly fleet: readonly string[];
}

const b58 = { enc: getBase58Encoder(), dec: getBase58Decoder() };

function flags(argv: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    const v = argv[i + 1];
    if (!k?.startsWith('--') || v === undefined) throw new DevnetError(`bad argument ${k ?? ''}`);
    out.set(k.slice(2), v);
  }
  return out;
}

function statePath(): string {
  const p = process.env[STATE_ENV];
  if (!p) throw new DevnetError(`${STATE_ENV} is not set`);
  return p;
}

async function readState(): Promise<{ creator: Wallet; fleet: Wallet[] }> {
  const s = JSON.parse(await readFile(statePath(), 'utf8')) as State;
  const seed = (x: string) => Uint8Array.from(b58.enc.encode(x));
  return {
    creator: await walletFromSeed(seed(s.creator)),
    fleet: await Promise.all(s.fleet.map((x) => walletFromSeed(seed(x)))),
  };
}

const sol = (lamports: bigint) => (Number(lamports) / 1e9).toFixed(9);

async function balance(d: Devnet, a: Address): Promise<bigint> {
  const { value } = await d.rpc.call<{ value: number }>('getBalance', [
    a,
    { commitment: 'confirmed' },
  ]);
  return BigInt(value);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const f = flags(rest);
  const rpc = createRpc(process.env.BUNNDLY_DEVNET_RPC ?? DEVNET_RPC_URL);
  const devnet = await openDevnet(rpc);
  const mainWallet = await loadKeypairFile(process.env[KEYPAIR_ENV]);
  const config = f.get('config') ?? DEFAULT_CONFIG;

  switch (command) {
    case 'balance': {
      console.log(
        `main ${mainWallet.address} ${sol(await balance(devnet, mainWallet.address))} SOL`,
      );
      return;
    }
    case 'simulate-token': {
      const mint = await walletFromSeed(newSeed());
      const ix = await initializeDbcPool({
        config,
        creator: mainWallet.address,
        baseMint: mint.address,
        payer: mainWallet.address,
        name: 'Bunndly devnet test',
        symbol: 'BDT',
        uri: '',
      });
      const sim = await devnet.simulate([ix], mainWallet.address);
      console.log(
        JSON.stringify({ mint: mint.address, err: sim.err, units: sim.unitsConsumed }, null, 2),
      );
      console.log(sim.logs.join('\n'));
      return;
    }
    case 'fund': {
      const n = Number(f.get('wallets') ?? '5');
      const lamports = BigInt(Math.round(Number(f.get('sol') ?? '0.05') * 1e9));
      const seeds = [newSeed(), ...Array.from({ length: n }, () => newSeed())];
      const wallets = await Promise.all(seeds.map((s) => walletFromSeed(s)));
      const state: State = {
        creator: b58.dec.decode(seeds[0] ?? new Uint8Array()),
        fleet: seeds.slice(1).map((s) => b58.dec.decode(s)),
      };
      await writeFile(statePath(), JSON.stringify(state), { flag: 'wx' });
      const sent = await devnet.send(
        wallets.map((w) => transfer(mainWallet.address, w.address, lamports)),
        [mainWallet],
      );
      console.log(
        `funded ${String(wallets.length)} x ${sol(lamports)} SOL in ${sent.signature} slot ${String(sent.slot)}`,
      );
      console.log(`creator ${wallets[0]?.address ?? ''}`);
      for (const w of wallets.slice(1)) console.log(`fleet   ${w.address}`);
      return;
    }
    case 'create-token': {
      const { creator } = await readState();
      const mint = await walletFromSeed(newSeed());
      const ix = await initializeDbcPool({
        config,
        creator: creator.address,
        baseMint: mint.address,
        payer: creator.address,
        name: f.get('name') ?? 'Bunndly devnet test',
        symbol: f.get('symbol') ?? 'BDT',
        uri: '',
      });
      const sent = await devnet.send([ix], [creator, mint]);
      const { pool } = await dbcTokenAccounts(config, mint.address);
      console.log(
        JSON.stringify(
          {
            mint: mint.address,
            pool,
            creator: creator.address,
            signature: sent.signature,
            s0: sent.slot,
            sentAt: new Date(sent.sentAtMs).toISOString(),
            confirmedAt: new Date(sent.confirmedAtMs).toISOString(),
          },
          null,
          2,
        ),
      );
      return;
    }
    case 'report': {
      const mint = f.get('mint');
      const s0sig = f.get('s0');
      if (!mint || !s0sig) throw new DevnetError('report needs --mint and --s0');
      const s0tx = await getTransaction(rpc, s0sig);
      if (!s0tx) throw new DevnetError(`S0 transaction ${s0sig} not found`);
      const wallets =
        f.get('wallets')?.split(',') ?? (await readState()).fleet.map((w) => w.address);
      const max = f.has('max-spend-lamports') ? BigInt(f.get('max-spend-lamports') ?? '0') : null;
      const rows: BuyRow[] = [];
      for (const wallet of wallets) {
        const sigs = await rpc.call<{ signature: string; slot: number }[]>(
          'getSignaturesForAddress',
          [wallet, { limit: 25, commitment: 'confirmed' }],
        );
        for (const s of sigs.filter((x) => x.slot >= s0tx.slot)) {
          const tx = await getTransaction(rpc, s.signature);
          if (!tx) continue;
          const row = buyRow(wallet, mint, s.signature, s0tx.slot, tx);
          if (row.tokensReceived > 0n || (!row.ok && row.slot >= s0tx.slot)) rows.push(row);
        }
      }
      console.log(`S0 ${String(s0tx.slot)} (${s0sig})`);
      console.log(
        'wallet | signature | slot | slot-S0 | ok | SOL spent | fee | tokens | <= max spend',
      );
      for (const r of rows.sort((a, b) => a.slot - b.slot)) {
        console.log(
          [
            r.wallet,
            r.signature,
            r.slot,
            `+${String(r.deltaS0)}`,
            r.ok ? 'ok' : 'FAILED',
            sol(r.solSpent),
            String(r.fee),
            String(r.tokensReceived),
            max === null ? '-' : r.solSpent <= max ? 'yes' : 'NO',
          ].join(' | '),
        );
      }
      for (const w of wallets) {
        const n = rows.filter((r) => r.wallet === w && r.ok).length;
        if (n !== 1) console.log(`WARNING ${w}: ${String(n)} successful buys of ${mint}`);
      }
      return;
    }
    case 'refund': {
      const { creator, fleet } = await readState();
      for (const w of [creator, ...fleet]) {
        const have = await balance(devnet, w.address);
        if (have <= FEE_LAMPORTS) continue;
        const sent = await devnet.send(
          [transfer(w.address, mainWallet.address, have - FEE_LAMPORTS)],
          [w],
        );
        console.log(`${w.address} -> main ${sol(have - FEE_LAMPORTS)} SOL ${sent.signature}`);
      }
      return;
    }
    default:
      throw new DevnetError(`unknown command ${command ?? ''}`);
  }
}

main().catch((e: unknown) => {
  // Only DevnetError messages are printed; they never contain key material.
  console.error(e instanceof DevnetError ? e.message : 'failed (details withheld)');
  process.exitCode = 1;
});
