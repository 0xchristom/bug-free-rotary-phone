/** Test transactions built with @solana/kit, and `/order` answers around them (BUNNDLY-22). */
import { readFileSync } from 'node:fs';
import {
  AccountRole,
  address,
  appendTransactionMessageInstruction,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  getBase64Decoder,
  getTransactionEncoder,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type SignatureBytes,
} from '@solana/kit';
import { parseOrder, type JupiterOrder } from '../../src/jupiter/client.ts';

export const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
/** A market maker address from a real JupiterZ answer (fixture). */
export const MAKER = 'Grr9WnZdcetQywtFXog81UhqmnJyvFhb4AT3ipw44mZP';
export const OTHER_SIGNER = 'gasTzr94Pmp4Gf8vknQnqxeYxdgwFjbgdJa4msYRpnB';
const SYSTEM = address('11111111111111111111111111111111');

export interface TxOptions {
  readonly feePayer: string;
  /** Further required signers, after the fee payer. */
  readonly signers?: readonly string[];
  readonly version?: 0 | 'legacy';
  /** Signatures already present (e.g. a market maker's), by address. */
  readonly preSigned?: Readonly<Record<string, Uint8Array>>;
}

/** Base64 wire transaction with one instruction that needs the given signers. */
export function buildTransaction(options: TxOptions): string {
  const message = pipe(
    createTransactionMessage({ version: options.version ?? 0 }),
    (m) => setTransactionMessageFeePayer(address(options.feePayer), m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: blockhash('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
          lastValidBlockHeight: 1n,
        },
        m,
      ),
    (m) =>
      appendTransactionMessageInstruction(
        {
          programAddress: SYSTEM,
          accounts: (options.signers ?? []).map((s) => ({
            address: address(s),
            role: AccountRole.WRITABLE_SIGNER,
          })),
          data: new Uint8Array([2, 0, 0, 0]),
        },
        m,
      ),
  );
  const compiled = compileTransaction(message);
  const signatures: Record<Address, SignatureBytes | null> = { ...compiled.signatures };
  for (const [who, sig] of Object.entries(options.preSigned ?? {})) {
    signatures[address(who)] = sig as SignatureBytes;
  }
  return getBase64Decoder().decode(
    getTransactionEncoder().encode({ messageBytes: compiled.messageBytes, signatures }),
  );
}

const fixtures = JSON.parse(readFileSync('tests/fixtures/jupiter-order.mainnet.json', 'utf8')) as {
  cases: Record<string, { response: { body: unknown } }>;
};

/** A real `/order` answer from the fixtures, parsed by the client. */
export function realOrder(name: 'metisSuccess' | 'jupiterzSuccess'): JupiterOrder {
  const order = parseOrder(fixtures.cases[name]?.response.body);
  if (!order) throw new Error(name);
  return order;
}

/** An order for `taker` buying USDC for `amount`, around a given transaction. */
export function orderFor(
  taker: string,
  transaction: string | null,
  overrides: Partial<JupiterOrder> = {},
): JupiterOrder {
  return {
    ...realOrder('metisSuccess'),
    taker,
    signatureFeePayer: taker,
    outputMint: USDC,
    inAmount: 10_000_000n,
    transaction,
    ...overrides,
  };
}
