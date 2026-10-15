/**
 * Funds devnet test wallets from the devnet main wallet (BUNNDLY-48).
 *
 *   BUNNDLY_DEVNET_KEYPAIR=<path to the key file> node scripts/fund-devnet.ts 0.05 <address>...
 *
 * - The key file (solana-keygen format: a JSON array of 64 bytes) lives outside the repo;
 *   only its path comes in, through the environment. Neither the key nor the file's content
 *   is ever printed, logged or written anywhere.
 * - Devnet only: before every signature the RPC's genesis hash must be devnet's, or the
 *   script stops without signing.
 * - At most 0.5 SOL per address and 10 addresses per call: test money, not a faucet.
 */
import { readFileSync } from 'node:fs';
import {
  AccountRole,
  address,
  appendTransactionMessageInstruction,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type KeyPairSigner,
} from '@solana/kit';
import { DEVNET_GENESIS_HASH, publicRpcUrl } from '../src/core/network.ts';

const LAMPORTS_PER_SOL = 1_000_000_000n;
const MAX_LAMPORTS_PER_ADDRESS = LAMPORTS_PER_SOL / 2n;
const MAX_ADDRESSES = 10;
const CONFIRM_TIMEOUT_MS = 60_000;
const SYSTEM_PROGRAM = address('11111111111111111111111111111111');

function stop(message: string): never {
  process.stderr.write(`fund-devnet: ${message}\n`);
  process.exit(1);
}

function lamportsOf(sol: string): bigint {
  const match = /^(\d{1,3})(?:\.(\d{1,9}))?$/u.exec(sol);
  if (match === null) stop(`amount "${sol}" is not a SOL amount like 0.05`);
  const whole = BigInt(match[1] ?? '0');
  const fraction = BigInt((match[2] ?? '').padEnd(9, '0'));
  return whole * LAMPORTS_PER_SOL + fraction;
}

/** System `Transfer` (index 2, then u64 lamports, little-endian). */
function transfer(from: KeyPairSigner, to: string, lamports: bigint) {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, lamports, true);
  return {
    programAddress: SYSTEM_PROGRAM,
    accounts: [
      // The fee payer signer signs for this account too.
      { address: from.address, role: AccountRole.WRITABLE_SIGNER },
      { address: address(to), role: AccountRole.WRITABLE },
    ],
    data,
  };
}

async function loadSigner(path: string): Promise<KeyPairSigner> {
  let bytes: Uint8Array;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 64) throw new Error();
    if (!parsed.every((b) => typeof b === 'number' && Number.isInteger(b) && b >= 0 && b < 256)) {
      throw new Error();
    }
    bytes = Uint8Array.from(parsed as number[]);
  } catch {
    // Never echo the file: it holds the key.
    return stop('the key file cannot be read as a solana-keygen key (64-byte JSON array)');
  }
  try {
    return await createKeyPairSignerFromBytes(bytes);
  } finally {
    bytes.fill(0);
  }
}

const [amountArg, ...targets] = process.argv.slice(2);
if (amountArg === undefined || targets.length === 0) {
  stop('usage: node scripts/fund-devnet.ts <SOL per address> <address>...');
}
const lamports = lamportsOf(amountArg);
if (lamports <= 0n || lamports > MAX_LAMPORTS_PER_ADDRESS) stop('amount must be 0 to 0.5 SOL');
if (targets.length > MAX_ADDRESSES) stop(`at most ${String(MAX_ADDRESSES)} addresses per call`);
for (const t of targets) {
  try {
    address(t);
  } catch {
    stop(`"${t}" is not an address`);
  }
}
const keyPath = process.env.BUNNDLY_DEVNET_KEYPAIR;
if (keyPath === undefined || keyPath === '') stop('BUNNDLY_DEVNET_KEYPAIR is not set');

const rpcUrl = publicRpcUrl('devnet');
if (rpcUrl === null) stop('no devnet RPC');
const rpc = createSolanaRpc(rpcUrl);
const signer = await loadSigner(keyPath);
process.stdout.write(`main wallet ${signer.address}\n`);

for (const target of targets) {
  const genesis = await rpc.getGenesisHash().send();
  if (genesis !== DEVNET_GENESIS_HASH) stop('the RPC is not devnet: nothing was signed');
  const { value: latest } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
    (m) => appendTransactionMessageInstruction(transfer(signer, target, lamports), m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(signed);
  await rpc
    .sendTransaction(getBase64EncodedWireTransaction(signed), {
      encoding: 'base64',
      preflightCommitment: 'confirmed',
    })
    .send();
  const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
  let state = 'not confirmed in 60 s';
  while (Date.now() < deadline) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const status = value[0];
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
      state = status.err === null ? `confirmed in slot ${String(status.slot)}` : 'failed on chain';
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  const { value: balance } = await rpc.getBalance(address(target)).send();
  process.stdout.write(
    `${target} +${amountArg} SOL ${signature} ${state}, balance ${String(balance)}\n`,
  );
}
