/**
 * SOL balances of the fleet (SPEC 3.2): getMultipleAccounts in batches of at most 100
 * addresses, results in input order, lamports as bigint, a missing account counts as 0.
 */
import {
  address,
  createSolanaRpcFromTransport,
  type GetMultipleAccountsApi,
  type Rpc,
  type RpcTransport,
} from '@solana/kit';

/** getMultipleAccounts accepts at most 100 accounts per call. */
export const MAX_ACCOUNTS_PER_CALL = 100;

export type BalancesRpc = Rpc<GetMultipleAccountsApi>;

export function createBalancesRpc(transport: RpcTransport): BalancesRpc {
  return createSolanaRpcFromTransport(transport);
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Lamports per address, same order as the input. Batches run one after another. */
export async function fetchSolBalances(
  rpc: BalancesRpc,
  addresses: readonly string[],
): Promise<bigint[]> {
  const result: bigint[] = [];
  for (const batch of chunk(
    addresses.map((a) => address(a)),
    MAX_ACCOUNTS_PER_CALL,
  )) {
    const { value } = await rpc
      .getMultipleAccounts(batch, {
        encoding: 'base64',
        // Only lamports are needed: skip the account data.
        dataSlice: { offset: 0, length: 0 },
        commitment: 'confirmed',
      })
      .send();
    if (value.length !== batch.length) throw new Error('getMultipleAccounts: wrong length');
    for (const account of value) result.push(account ? BigInt(account.lamports) : 0n);
  }
  return result;
}
