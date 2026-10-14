// @vitest-environment jsdom
/**
 * Why Buy and Sell are off, for each state of the target field (BUNNDLY-79): empty, still
 * checking, could not be checked (the field's message), and an address of the other kind.
 * Arm shows only for a creator wallet, so its texts are checked on the function itself.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError, ERROR_MESSAGES } from '../../src/core/index.ts';
import { App } from '../../src/ui/App.tsx';
import {
  ARM_TARGET,
  BUY_TARGET,
  CHECKING_TARGET,
  SELL_TARGET,
  targetReason,
} from '../../src/ui/target-reasons.ts';
import type { VaultInfo, VaultRequest, VaultStatus } from '../../src/worker/protocol.ts';
import {
  TARGET_LABEL,
  TARGET_WAIT,
  fleetInfo,
  mockStorage,
  mockVault,
  withDefaultGroup,
} from './fakes.ts';
import { setupUser } from './user.ts';

afterEach(cleanup);

/** The worker answers these: never (still checking), a refusal, a creator wallet. */
const HELD = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const REFUSED = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const WALLET = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';

function setup() {
  const base = fleetInfo(3);
  const info: VaultInfo = {
    ...base,
    settings: {
      ...base.settings,
      maxSpend: base.wallets.map((w) => ({ index: w.index, lamports: 10_000_000n })),
    },
    apiKeys: { ...base.apiKeys, helius: true },
  };
  const status: VaultStatus = {
    locked: false,
    network: info.settings.global.network,
    armed: false,
    info,
    buy: null,
    watch: null,
    groups: [],
  };
  const vault = mockVault(status);
  vault.request.mockImplementation((req: VaultRequest) => {
    switch (req.type) {
      case 'status':
      case 'activity':
        return Promise.resolve(withDefaultGroup(status));
      case 'refreshBalances':
        return Promise.resolve({
          balances: info.wallets.map((w) => ({ index: w.index, lamports: 1_000_000_000n })),
          network: info.settings.global.network,
          source: 'helius',
          fetchedAt: '2026-10-14T12:00:00.000Z',
        });
      case 'classifyTarget':
        if (req.address === HELD) return new Promise(() => undefined);
        if (req.address === REFUSED) return Promise.reject(new AppError('HELIUS_KEY_MISSING'));
        return Promise.resolve({ kind: 'wallet' });
      default:
        return Promise.reject(new Error(req.type));
    }
  });
  render(
    <App
      vault={vault.client}
      storage={mockStorage().env}
      statusPollMs={60_000}
      balanceRefreshMs={60_000}
    />,
  );
  return { user: setupUser() };
}

const why = (name: 'Buy' | 'Sell'): string | null =>
  screen.getByRole('button', { name }).getAttribute('aria-description');

async function paste(user: ReturnType<typeof setupUser>, address: string): Promise<void> {
  const field = screen.getByLabelText(TARGET_LABEL);
  await user.clear(field);
  await user.type(field, address);
}

describe('Buy and Sell say why they are off, for each state of the target', () => {
  it('empty, checking, could not be checked, a creator wallet', async () => {
    const { user } = setup();
    await screen.findByRole('heading', { name: 'Fleet' });

    expect(why('Buy')).toBe('Paste a token mint first.');
    expect(why('Sell')).toBe('Paste the mint of the token to sell.');

    await paste(user, HELD);
    await waitFor(() => {
      expect(why('Buy')).toBe('Checking the target…');
    }, TARGET_WAIT);
    expect(why('Sell')).toBe('Checking the target…');

    await paste(user, REFUSED);
    const refused = `Could not check the target: ${ERROR_MESSAGES.HELIUS_KEY_MISSING}`;
    await waitFor(() => {
      expect(why('Buy')).toBe(refused);
    }, TARGET_WAIT);
    expect(why('Sell')).toBe(refused);

    await paste(user, WALLET);
    await waitFor(() => {
      expect(why('Buy')).toBe(
        'BUY needs a token: arm the watcher and wait for this creator’s token, or paste a mint.',
      );
    }, TARGET_WAIT);
    expect(why('Sell')).toBe('SELL needs a token mint, not a creator wallet.');
  });
});

describe('targetReason', () => {
  it('Arm: empty, checking, refused, a token', () => {
    expect(targetReason({ kind: 'empty' }, ARM_TARGET)).toBe('Paste a creator wallet first.');
    expect(targetReason({ kind: 'checking', address: WALLET }, ARM_TARGET)).toBe(CHECKING_TARGET);
    expect(targetReason({ kind: 'error', message: 'Nope.' }, ARM_TARGET)).toBe(
      'Could not check the target: Nope.',
    );
    expect(
      targetReason(
        { kind: 'done', target: { address: HELD, kind: { kind: 'mint', program: 'spl-token' } } },
        ARM_TARGET,
      ),
    ).toBe('ARM needs a creator wallet, not a token.');
    // Buy and Sell keep their own texts for the empty field.
    expect(BUY_TARGET.empty).not.toBe(SELL_TARGET.empty);
  });
});
