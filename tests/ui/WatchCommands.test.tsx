// @vitest-environment jsdom
/** The creator address and the conditions for arming. Setup: WatchCommands.fixture.tsx. */
import { cleanup, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TARGET_LABEL, TARGET_WAIT } from './fakes.ts';
import { enter } from './user.ts';
import {
  FLEET_ADDRESS,
  MINT,
  setup,
  openTabB,
  typeCreator,
  armButton,
} from './WatchCommands.fixture.tsx';

describe('creator address and arming conditions', () => {
  it('validates the address and warns about a fleet address', async () => {
    const { user } = setup();
    await openTabB();
    const input = screen.getByLabelText(TARGET_LABEL);
    // Arm appears only for a creator wallet (mockup v2, BUNNDLY-73)
    expect(screen.queryByRole('button', { name: 'Arm' })).toBeNull();
    expect(screen.getByText('Paste a target to begin')).toBeTruthy();
    await user.type(input, 'not-an-address');
    expect(screen.getByRole('alert').textContent).toMatch(/Paste a full Solana address/u);
    expect(screen.queryByRole('button', { name: 'Arm' })).toBeNull();
    await user.clear(input);
    await user.type(input, 'So11111111111111111111111111111111111111112');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    await user.clear(input);
    await typeCreator(user, FLEET_ADDRESS);
    expect(
      await screen.findByText(/This is a wallet from this fleet/u, {}, TARGET_WAIT),
    ).toBeTruthy();
    await user.clear(input);
    await typeCreator(user);
    expect(input.getAttribute('aria-invalid')).toBeNull();
    expect(armButton()).toHaveProperty('disabled', false);
    expect(screen.getByText('Arm the fleet to buy the creator’s next token')).toBeTruthy();
    // a token is not a creator: no Arm, the strip offers Buy and Sell instead
    await user.clear(input);
    await enter(user, input, MINT);
    await screen.findByText('Token · SPL', {}, TARGET_WAIT);
    expect(screen.queryByRole('button', { name: 'Arm' })).toBeNull();
    expect(screen.getByText(/Buy and Sell act on the selected wallets/u)).toBeTruthy();
  });

  it('without a Helius key or a ready wallet the button says what is missing', async () => {
    const a = setup({ helius: false });
    await openTabB();
    await typeCreator(a.user);
    expect(armButton()).toHaveProperty('disabled', true);
    expect(screen.getByText('The watcher needs a Helius key (Settings).')).toBeTruthy();
    cleanup();
    const b = setup({ maxSpend: false });
    await openTabB();
    await typeCreator(b.user);
    expect(armButton()).toHaveProperty('disabled', true);
    expect(screen.getByText(/No ready wallets/u)).toBeTruthy();
  });
});
