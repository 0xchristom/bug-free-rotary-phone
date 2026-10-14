// @vitest-environment jsdom
/**
 * The wizard's unsaved-file guard changes in the commit that changes the screen
 * (BUNNDLY-67). Each click here happens inside `waitFor`, at the first DOM change that
 * shows its button: after React's commit (mutations and layout effects), before any
 * passive effect. A guard set one render late (in a passive effect) misses it.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/ui/App.tsx';
import { LOCKED, fleetInfo, mockStorage, mockVault } from './fakes.ts';
import { setupUser } from './user.ts';

const PASSWORD = 'zielony Kot, 7 krzeseł; drabina';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** A vault whose `create` answers at once; the fleet is unlocked from then on. */
function createdVault() {
  return mockVault(LOCKED, (req) =>
    Promise.resolve({
      fileText: '{"version":1,"encrypted":true}',
      info: fleetInfo(req.walletCount, req.fleetName),
    }),
  );
}

async function createFleet(): Promise<void> {
  const user = setupUser();
  await user.click(await screen.findByRole('button', { name: 'Create a new fleet' }));
  await user.clear(screen.getByLabelText('Number of wallets'));
  await user.type(screen.getByLabelText('Number of wallets'), '3');
  await user.type(screen.getByLabelText('Fleet name'), 'Flota testowa');
  await user.type(screen.getByLabelText('Password'), PASSWORD);
  await user.type(screen.getByLabelText('Repeat the password'), PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Create the fleet' }));
}

/**
 * Clicks the button once, at the first moment it and the heading are both on screen.
 * `fireEvent` dispatches synchronously: no waiting between seeing the screen and the click.
 */
async function clickAtFirstSight(heading: string, button: string): Promise<void> {
  let clicked = false;
  await waitFor(() => {
    if (clicked) return;
    screen.getByRole('heading', { name: heading });
    const target = screen.getByRole('button', { name: button });
    clicked = true;
    fireEvent.click(target);
  });
}

describe('the unsaved-file guard moves with the wizard screen', () => {
  it('Dashboard clicked as soon as "Fleet created" shows: the question comes, No stays', async () => {
    const vault = createdVault();
    render(<App vault={vault.client} storage={mockStorage().env} statusPollMs={60_000} />);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await createFleet();
    await clickAtFirstSight('Fleet created', 'Dashboard');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { name: 'Fleet created' })).toBeTruthy();
  });

  it('Go to the fleet clicked as soon as the file is saved: no question, the fleet opens', async () => {
    const vault = createdVault();
    render(<App vault={vault.client} storage={mockStorage().env} statusPollMs={60_000} />);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await createFleet();
    await screen.findByRole('heading', { name: 'Fleet created' });
    fireEvent.click(screen.getByRole('button', { name: 'Save the fleet file' }));
    await clickAtFirstSight('Fleet file saved', 'Go to the fleet');
    expect(confirm).not.toHaveBeenCalled();
    expect(await screen.findByRole('heading', { name: 'Fleet' })).toBeTruthy();
  });
});
