/**
 * Signing an `/order` transaction for one wallet (BUNNDLY-22, D-028). Runs only inside
 * the vault worker, called by the executor there; the UI protocol has no signing request
 * (D-013). The key is used only after `checkOrderTransaction` passed.
 *
 * Partial signature: only the taker's slot is filled. Other slots (a JupiterZ market
 * maker, a gas sponsor) stay byte for byte; the market maker signs in `/execute`.
 */
import {
  createKeyPairFromBytes,
  getAddressFromPublicKey,
  getBase58Decoder,
  getBase64Decoder,
  getTransactionEncoder,
  signBytes,
  type Address,
  type SignatureBytes,
} from '@solana/kit';
import type { CheckedOrder } from '../executor/order-check.ts';

export interface SignedOrder {
  /** Base64 wire transaction for `/execute`. */
  readonly signedTransaction: string;
  /** The transaction signature (first slot) when the taker pays the fee, else null. */
  readonly signature: string | null;
}

/** Thrown only for a key that does not belong to the taker (a vault bug, never data). */
export class WrongSigningKeyError extends Error {
  override readonly name = 'WrongSigningKeyError';
}

/** Signs the checked transaction with the taker's 64-byte secret key. */
export async function signCheckedOrder(
  secretKey: Uint8Array,
  checked: CheckedOrder,
): Promise<SignedOrder> {
  // Also verifies that the public half matches the private half.
  const keyPair = await createKeyPairFromBytes(secretKey);
  const signer = await getAddressFromPublicKey(keyPair.publicKey);
  if (signer !== checked.taker) throw new WrongSigningKeyError();
  const { transaction } = checked;
  const signature = await signBytes(keyPair.privateKey, transaction.messageBytes);
  const signatures: Record<Address, SignatureBytes | null> = { ...transaction.signatures };
  signatures[signer] = signature;
  const bytes = getTransactionEncoder().encode({
    messageBytes: transaction.messageBytes,
    signatures,
  });
  return {
    signedTransaction: getBase64Decoder().decode(bytes),
    signature: checked.takerPaysFee ? getBase58Decoder().decode(signature) : null,
  };
}
