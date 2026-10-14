/**
 * What a pasted address is (BUNNDLY-59), against real mainnet accounts
 * (tests/fixtures/token-accounts.mainnet.json and program-account.mainnet.json; slot and
 * source are in the files). No network: a fake transport serves the stored accounts.
 */
import { readFileSync } from 'node:fs';
import type { RpcTransport } from '@solana/kit';
import { describe, expect, it } from 'vitest';
import { createBalancesRpc } from '../../src/chain/index.ts';
import { fetchTarget, parseTargetAddress } from '../../src/chain/target.ts';
import { AppError } from '../../src/core/errors.ts';

interface StoredAccount {
  readonly owner: string;
  readonly lamports: string;
  readonly data: string;
  readonly executable: boolean;
  readonly space: number;
}

const read = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));

const TOKENS = read('token-accounts.mainnet.json') as {
  accounts: Record<string, StoredAccount | null>;
};
const PROGRAM = read('program-account.mainnet.json') as { address: string; account: StoredAccount };

// Addresses copied from the fixture files, which label each one (spl.mint, spl.ata,
// token2022.mint, missing.ata, …; the program file names the Jupiter v6 program).
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN_2022_MINT = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo';
const SPL_TOKEN_ACCOUNT = '3Tn7BAWv282J1sH1pqF9gtCdaorRFoVMcTpgCqwPEBvf';
const TOKEN_2022_ACCOUNT = '47od2TPRvqJipfPVWZdyenLEngPw8hC36nDxiLyvGsEP';
const SYSTEM_WALLET = '5gUuDFHswKi2QMA1qJHf6FEVhNCrHnyAdfWniMaUUPE4';
const NO_ACCOUNT = 'HyPmLPSyJxtHC6f2FF4VGtTnxBmMbeENzDAWhvPjVM3Y';
const JUPITER_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';

/** Serves fixture accounts; `extra` adds hand-made ones. Counts the calls. */
function transport(extra: Record<string, StoredAccount> = {}) {
  const accounts: Record<string, StoredAccount | null> = {
    ...TOKENS.accounts,
    [PROGRAM.address]: PROGRAM.account,
    ...extra,
  };
  let calls = 0;
  const t = (config: { payload: unknown }) => {
    calls += 1;
    const payload = config.payload as { id: unknown; params: [string[]] };
    const value = payload.params[0].map((addr) => {
      const acc = accounts[addr];
      if (!acc) return null;
      return {
        owner: acc.owner,
        lamports: BigInt(acc.lamports),
        data: [acc.data, 'base64'],
        executable: acc.executable,
        rentEpoch: 0n,
        space: BigInt(acc.space),
      };
    });
    return Promise.resolve({
      jsonrpc: '2.0',
      id: payload.id,
      result: { context: { slot: 1n }, value },
    });
  };
  return { rpc: createBalancesRpc(t as unknown as RpcTransport), calls: () => calls };
}

async function kindOf(address: string, extra: Record<string, StoredAccount> = {}) {
  const { rpc } = transport(extra);
  return fetchTarget(rpc, address).then(
    (k) => k,
    (e: unknown) => (e instanceof AppError ? e.code : String(e)),
  );
}

describe('target kind (mainnet accounts)', () => {
  it('a SPL Token mint and a Token-2022 mint are tokens, with their program', async () => {
    expect(await kindOf(USDC_MINT)).toEqual({ kind: 'mint', program: 'spl-token' });
    expect(await kindOf(TOKEN_2022_MINT)).toEqual({ kind: 'mint', program: 'token-2022' });
  });

  it('a System Program wallet and an address without an account are wallets', async () => {
    expect(await kindOf(SYSTEM_WALLET)).toEqual({ kind: 'wallet' });
    expect(await kindOf(NO_ACCOUNT)).toEqual({ kind: 'wallet' });
  });

  it('token accounts of both programs are named as token accounts', async () => {
    expect(await kindOf(SPL_TOKEN_ACCOUNT)).toBe('TARGET_IS_TOKEN_ACCOUNT');
    expect(await kindOf(TOKEN_2022_ACCOUNT)).toBe('TARGET_IS_TOKEN_ACCOUNT');
  });

  it('a program is named as a program', async () => {
    expect(await kindOf(JUPITER_PROGRAM)).toBe('TARGET_IS_PROGRAM');
  });

  it('anything else is refused, not guessed', async () => {
    const base = { lamports: '1', executable: false };
    // System account with data (a nonce account is 80 bytes).
    const nonce = { ...base, owner: '11111111111111111111111111111111', space: 80 };
    expect(
      await kindOf(SYSTEM_WALLET, { [SYSTEM_WALLET]: { ...nonce, data: 'A'.repeat(108) } }),
    ).toBe('TARGET_UNSUPPORTED');
    // An account of some other program.
    expect(
      await kindOf(SYSTEM_WALLET, {
        [SYSTEM_WALLET]: { ...base, owner: JUPITER_PROGRAM, data: '', space: 0 },
      }),
    ).toBe('TARGET_UNSUPPORTED');
    // Token program owner, but neither a mint nor a token account (e.g. a multisig, 355 B).
    expect(
      await kindOf(SYSTEM_WALLET, {
        [SYSTEM_WALLET]: {
          ...base,
          owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
          data: 'A'.repeat(476),
          space: 355,
        },
      }),
    ).toBe('TARGET_UNSUPPORTED');
  });

  it('one RPC call per address', async () => {
    const { rpc, calls } = transport();
    await fetchTarget(rpc, USDC_MINT);
    expect(calls()).toBe(1);
  });
});

describe('target address text', () => {
  it('trims and accepts a base58 address of 32 bytes', () => {
    expect(parseTargetAddress(`  ${USDC_MINT}\n`)).toBe(USDC_MINT);
  });

  it('refuses text that is not an address', () => {
    for (const text of ['', 'not-an-address', `${USDC_MINT}x`, '0'.repeat(44)]) {
      expect(() => parseTargetAddress(text), text).toThrow(
        expect.objectContaining({ code: 'INVALID_TARGET_ADDRESS' }) as Error,
      );
    }
  });
});
