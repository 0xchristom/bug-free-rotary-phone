// @vitest-environment jsdom
/** Creating wallets from the fleet table. Setup: FleetTable.fixture.tsx. */
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { setupUser } from './user.ts';
import { setup, ready, selectBox } from './FleetTable.fixture.tsx';

describe('create wallets', () => {
  async function openCreate(user: ReturnType<typeof setupUser>): Promise<HTMLElement> {
    await user.click(screen.getByRole('button', { name: 'Create wallets' }));
    return screen.getByRole('dialog', { name: 'Create wallets' });
  }

  it('a count of 5 sends addWallets with 5 and the new wallets join the table', async () => {
    const { user, added, vault } = setup();
    await ready();
    const popover = await openCreate(user);
    // nothing typed yet: nothing to create
    expect(within(popover).getByRole('button', { name: 'Create' })).toHaveProperty(
      'disabled',
      true,
    );
    await user.type(within(popover).getByLabelText('How many'), '5');
    await user.click(within(popover).getByRole('button', { name: 'Create' }));

    await screen.findByText(/New wallets: 5\./u);
    expect(added).toEqual([5]);
    // BUNNDLY-90: the new labels in the rail; the fake names index 3…7 "Wallet 3"…"Wallet 7"
    expect(screen.getByRole('status', { name: 'Last command' }).textContent).toBe(
      'Created Wallet 3–7',
    );
    expect(vault.request.mock.calls.map(([r]) => r).filter((r) => r.type === 'addWallets')).toEqual(
      [{ type: 'addWallets', count: 5 }],
    );
    expect(screen.queryByRole('dialog', { name: 'Create wallets' })).toBeNull();
    expect(screen.getByText('8 of 8 selected')).toBeTruthy();
    expect(selectBox('Wallet 7').checked).toBe(true);
    // the old wallets keep their labels
    expect(selectBox('W01')).toBeTruthy();
  });

  it('a count outside 1…room blocks the button and says why at the field', async () => {
    const { user, added } = setup({ count: 98 });
    await ready();
    const popover = await openCreate(user);
    const field = within(popover).getByLabelText('How many');
    const create = within(popover).getByRole<HTMLButtonElement>('button', { name: 'Create' });
    const reason = 'You can create 1 to 2 wallets (at most 100 in total).';
    const help = (): HTMLElement => within(popover).getByText(reason);
    expect(field.getAttribute('aria-describedby')).toBe(help().id);

    for (const text of ['0', '3', '101', '1.5', '-1', 'two']) {
      await user.clear(field);
      await user.type(field, text);
      expect(create.disabled).toBe(true);
      expect(help().className).toBe('field-error');
      expect(field.getAttribute('aria-invalid')).toBe('true');
    }
    // Enter does not get around the disabled button, and neither does a submit of the form
    await user.type(field, '{Enter}');
    const form = field.closest('form');
    if (!form) throw new Error('form');
    fireEvent.submit(form);
    await act(() => Promise.resolve());
    expect(added).toEqual([]);

    for (const text of ['1', '2']) {
      await user.clear(field);
      await user.type(field, text);
      expect(create.disabled).toBe(false);
      expect(help().className).toBe('hint');
      expect(field.getAttribute('aria-invalid')).toBeNull();
    }
    await user.type(field, '{Enter}');
    await screen.findByText(/New wallets: 2\./u);
    expect(added).toEqual([2]);
  }, 30_000);

  // BUNNDLY-82: the reason is the button's description and tooltip, not text in the toolbar,
  // which at 1280 px pushed the next buttons to a second row.
  it('a full fleet and unsaved table changes turn the button off; the reason is on the button', async () => {
    const UNSAVED = 'Save the table changes and the updated fleet file first, then create wallets.';
    const FULL = 'The fleet already has the maximum of 100 wallets.';
    const { user } = setup({ count: 3 });
    await ready();
    const create = (): HTMLElement => screen.getByRole('button', { name: 'Create wallets' });
    expect(create()).toHaveProperty('disabled', false);
    expect(create().getAttribute('aria-description')).toBeNull();
    await user.click(selectBox('W01'));
    expect(create()).toHaveProperty('disabled', true);
    expect(create().getAttribute('aria-description')).toBe(UNSAVED);
    expect(create().getAttribute('title')).toBe(UNSAVED);
    expect(screen.queryByText(UNSAVED)).toBeNull();
    cleanup();

    setup({ count: 100 });
    await ready();
    expect(create()).toHaveProperty('disabled', true);
    expect(create().getAttribute('aria-description')).toBe(FULL);
    expect(screen.queryByText(FULL)).toBeNull();
  }, 30_000);

  it('Cancel closes the popover, sends nothing and forgets the typed count', async () => {
    const { user, added } = setup();
    await ready();
    const popover = await openCreate(user);
    await user.type(within(popover).getByLabelText('How many'), '7');
    await user.click(within(popover).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Create wallets' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Create wallets' }));
    expect(added).toEqual([]);
    const again = await openCreate(user);
    expect(within(again).getByLabelText<HTMLInputElement>('How many').value).toBe('');
  });
});
