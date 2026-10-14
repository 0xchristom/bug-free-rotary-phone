// @vitest-environment jsdom
/** The fleet table: balances, readiness, the wallet cell and the selection. Setup: FleetTable.fixture.tsx. */
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FleetSettingsV1 } from '../../src/core/index.ts';
import type { VaultInfo } from '../../src/worker/protocol.ts';
import { TARGET_LABEL, TARGET_WAIT, TOKEN_2022_MINT, TOKEN_ACCOUNT, fleetInfo } from './fakes.ts';
import { eventually } from './settle.ts';
import { enter } from './user.ts';
import {
  SOL,
  BALANCE,
  TOKEN,
  setup,
  row,
  ready,
  cells,
  selectBox,
  headerBox,
  summaryValue,
} from './FleetTable.fixture.tsx';

describe('fleet table', () => {
  it('has the columns of the compact table and no "Actions" column', async () => {
    setup();
    await ready();
    const table = screen.getByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((th) => th.textContent),
    ).toEqual([
      '',
      'Wallet',
      // where the balances come from, next to the sort button (BUNNDLY-57)
      'BalancePolling',
      'Buy amount',
      'Priority fee',
      'Slippage',
      'Fill',
      'Tokens',
      'Status',
      'Last transaction',
      'Wallet tools',
    ]);
    expect(within(table).queryByText('Actions')).toBeNull();
    // one row per wallet under the header row
    expect(within(table).getAllByRole('row')).toHaveLength(4);
  });

  it('shows balance, max spend and readiness; a too small reserve is said under the field', async () => {
    const { user } = setup({
      settings: {
        maxSpend: [
          { index: 0, lamports: 985_000_000n }, // reserve exactly 0.015
          { index: 1, lamports: 985_000_001n }, // one lamport short
        ],
      },
    });
    await ready();
    expect(within(row('W01')).getByLabelText<HTMLInputElement>('Buy amount W01').value).toBe(
      '0.985',
    );
    expect(row('W01').dataset.ready).toBe('true');
    expect(within(row('W01')).getByText('Idle')).toBeTruthy();
    expect(within(row('W01')).queryByText(/minimum reserve/u)).toBeNull();

    expect(row('W02').className).toBe('row-error');
    expect(row('W02').dataset.ready).toBe('false');
    expect(within(row('W02')).getByText('Low reserve')).toBeTruthy();
    // 1 000 000 000 − 985 000 001 = 14 999 999 lamports
    expect(
      within(row('W02')).getByText('Leaves 0.014999999 SOL; the minimum reserve is 0.015 SOL.'),
    ).toBeTruthy();

    // no max spend: neither ready nor red
    expect(row('W03').dataset.ready).toBe('false');
    expect(row('W03').className).toBe('');
    expect(within(row('W03')).getByText('No amount')).toBeTruthy();

    await user.type(within(row('W03')).getByLabelText('Buy amount W03'), '2{Enter}');
    expect(await within(row('W03')).findByText('More than the wallet balance.')).toBeTruthy();
    expect(row('W03').className).toBe('row-error');
  });

  it('the balance is a dash before the first read, never a zero', async () => {
    setup({ holdBalances: true });
    expect(await screen.findByText('RPC: no read yet')).toBeTruthy();
    for (const label of ['W01', 'W02', 'W03']) expect(cells(label)[BALANCE]).toBe('—');
    expect(within(row('W01')).getByText('No amount')).toBeTruthy();
  });

  it('an empty wallet shows 0 with the SOL mark once it is read', async () => {
    setup({ lamports: (i) => (i === 1 ? 0n : 2_500_000_000n) });
    await ready();
    expect(cells('W02')[BALANCE]).toBe('0');
    expect(cells('W01')[BALANCE]).toBe('2.5');
    const cell = within(row('W01')).getAllByRole('cell')[BALANCE];
    expect(cell?.querySelector('svg.k-i-sol')).toBeTruthy();
  });

  it('invalid amounts show English messages and are not saved', async () => {
    const { user, saved } = setup();
    await ready();
    const input = within(row('W01')).getByLabelText('Buy amount W01');
    for (const [text, message] of [
      ['-1', 'The amount cannot be negative.'],
      ['0,1234567891', 'Use at most 9 decimal places (1 lamport).'],
      ['lots', 'Enter an amount in SOL, e.g. 0.25.'],
    ] as const) {
      await user.clear(input);
      await user.type(input, `${text}{Enter}`);
      expect(within(row('W01')).getByText(message)).toBeTruthy();
    }
    // a percent is a whole number from 1 to 100
    await user.click(
      within(row('W01')).getByRole('button', { name: /^Unit of the buy amount W01/u }),
    );
    await user.clear(input);
    await user.type(input, '101{Enter}');
    expect(within(row('W01')).getByText('Enter a whole number from 1 to 100.')).toBeTruthy();
    expect(saved).toEqual([]);
  });

  it('saves the amount on Enter and the selection on click, then the file on click', async () => {
    const { user, saved, storage } = setup();
    await ready();
    await user.type(within(row('W01')).getByLabelText('Buy amount W01'), '0.5{Enter}');
    await screen.findByText(/The trade settings are saved in the vault/u);
    // leaving the field and its unit button saves too
    await user.type(within(row('W03')).getByLabelText('Buy amount W03'), '0,25');
    await user.tab(); // to the unit button: still the same control
    expect(saved).toHaveLength(1);
    await user.tab();
    await eventually(() => {
      expect(saved).toHaveLength(2);
    });
    expect(saved[1]).toEqual({
      maxSpend: [
        { index: 0, lamports: 500_000_000n },
        { index: 2, lamports: 250_000_000n },
      ],
      active: [],
      global: fleetInfo().settings.global,
      trade: fleetInfo().settings.trade,
    });
    expect(storage.showDirectoryPicker).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Save the updated fleet file' }));
    expect(await screen.findByText(/with the new trade settings/u)).toBeTruthy();

    await user.click(selectBox('W02'));
    expect(screen.getByText('You have unsaved table changes.')).toBeTruthy();
    expect(row('W02').className).toBe('unsel');
    expect(within(row('W02')).getByText('Not selected')).toBeTruthy();

    // unsaved edits are protected like an unsaved file
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Save table changes' }));
    await screen.findByText(/The selected wallets are saved in the vault/u);
    expect(saved[2]).toEqual({
      maxSpend: saved[1]?.maxSpend,
      active: [{ index: 1, active: false }],
      global: fleetInfo().settings.global,
    });
    // the file from the first save is there: replacing it is confirmed
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: 'Save the updated fleet file' }));
    expect(await screen.findByText(/with the new fleet settings/u)).toBeTruthy();
    expect(confirm).toHaveBeenCalledOnce();
    expect(storage.files.get('Flota testowa.keystore.json')).toBe('{"saved":true}');
    expect(screen.queryByText('You have unsaved table changes.')).toBeNull();
  });

  it('a token mint shows balances with decimals; a token account is named at the field', async () => {
    const { user } = setup();
    await ready();
    expect(cells('W02')[TOKEN]).toBe('—');
    await user.type(screen.getByLabelText(TARGET_LABEL), TOKEN_2022_MINT);
    expect(
      await screen.findByRole('columnheader', { name: 'Tokens (Token-2022)' }, TARGET_WAIT),
    ).toBeTruthy();
    expect(cells('W02')[TOKEN]).toBe('1.5');
    expect(cells('W03')[TOKEN]).toBe('3');

    await user.clear(screen.getByLabelText(TARGET_LABEL));
    await enter(user, screen.getByLabelText(TARGET_LABEL), TOKEN_ACCOUNT);
    // the message sits at the field, the table stays
    const alert = await screen.findByRole('alert', {}, TARGET_WAIT);
    expect(alert.textContent).toContain('is a token account, not a token');
    expect(alert.id).toBe(screen.getByLabelText(TARGET_LABEL).getAttribute('aria-describedby'));
    expect(screen.getByRole('columnheader', { name: 'Tokens' })).toBeTruthy();
    expect(screen.getByRole('table')).toBeTruthy();
  });

  it('after a wrong target the SOL balances keep refreshing (without a mint)', async () => {
    const { user, vault, setBalances } = setup();
    await ready();
    await enter(user, screen.getByLabelText(TARGET_LABEL), TOKEN_ACCOUNT);
    await screen.findByRole('alert', {}, TARGET_WAIT);
    const refreshes = (): { mint?: string }[] =>
      vault.request.mock.calls.map(([r]) => r).filter((r) => r.type === 'refreshBalances');
    // right after the error it refreshes again without the mint
    await waitFor(() => {
      expect(refreshes().at(-1)?.mint).toBeUndefined();
    });
    setBalances(() => 3n * SOL);
    await user.click(screen.getByRole('button', { name: /^Fleet balance:/u }));
    // 1 SOL before, 3 after: the cell says the balance and, under it, the change (BUNNDLY-92)
    await waitFor(() => {
      expect(cells('W01')[BALANCE]).toBe('3+2');
    });
    expect(refreshes().at(-1)?.mint).toBeUndefined();
    expect(screen.getByRole('alert').textContent).toContain('is a token account, not a token');

    // a corrected mint clears the message and reads the token
    await user.clear(screen.getByLabelText(TARGET_LABEL));
    await user.type(screen.getByLabelText(TARGET_LABEL), TOKEN_2022_MINT);
    expect(
      await screen.findByRole('columnheader', { name: 'Tokens (Token-2022)' }, TARGET_WAIT),
    ).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('settings reset while reading the file are announced', async () => {
    setup({ settings: { resetFields: ['minReserveLamports', 'maxAttempts'] } });
    await ready();
    expect(screen.getByText(/default\s+values: minimum reserve, attempts/u)).toBeTruthy();
  });
});

describe('wallet cell', () => {
  // Two public program addresses, typed here by hand.
  const FIRST = 'So11111111111111111111111111111111111111112';
  const SECOND = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  const wallets: VaultInfo['wallets'] = [
    { index: 0, address: FIRST, derivationPath: "m/44'/501'/0'/0'", label: 'Wallet 0' },
    { index: 1, address: SECOND, derivationPath: "m/44'/501'/1'/0'", label: 'Wallet 1' },
  ];

  function explorerLink(label: string): HTMLAnchorElement {
    return within(row(label)).getByRole<HTMLAnchorElement>('link', {
      name: `Open ${label} in the explorer`,
    });
  }

  it('shows the first 4 and the last 4 characters of the address', async () => {
    setup({ wallets });
    await ready();
    expect(within(row('Wallet 0')).getByText('So11…1112')).toBeTruthy();
    expect(within(row('Wallet 1')).getByText('Toke…Q5DA')).toBeTruthy();
    // the full address is one hover away and in the QR popover
    expect(within(row('Wallet 1')).getByText('Toke…Q5DA').getAttribute('title')).toBe(SECOND);
    expect(within(row('Wallet 1')).queryByText(SECOND)).toBeNull();
  });

  it('copy puts the full address of that wallet on the clipboard and says so', async () => {
    const { user } = setup({ wallets });
    await ready();
    await user.click(screen.getByRole('button', { name: 'Copy address Wallet 1' }));
    expect(await navigator.clipboard.readText()).toBe(SECOND);
    expect(await screen.findByText('Address copied')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Copy address Wallet 0' }));
    expect(await navigator.clipboard.readText()).toBe(FIRST);
  });

  it('a refused clipboard is an error on the screen, not a toast', async () => {
    const { user } = setup({ wallets });
    await ready();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValueOnce(new Error('denied'));
    await user.click(screen.getByRole('button', { name: 'Copy address Wallet 0' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'The address could not be copied.',
    );
    expect(screen.queryByText('Address copied')).toBeNull();
  });

  it('the explorer link of a mainnet fleet is the account page', async () => {
    const global = { ...fleetInfo().settings.global, network: 'mainnet', explorer: 'orb' };
    setup({ wallets, settings: { global: global as FleetSettingsV1['global'] } });
    await ready();
    expect(explorerLink('Wallet 0').getAttribute('href')).toBe(
      'https://orbmarkets.io/address/So11111111111111111111111111111111111111112',
    );
    expect(explorerLink('Wallet 1').getAttribute('href')).toBe(
      'https://orbmarkets.io/address/TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    );
    expect(explorerLink('Wallet 0').getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('the explorer link of a devnet fleet leads to the devnet page', async () => {
    const global = { ...fleetInfo().settings.global, network: 'devnet', explorer: 'solscan' };
    setup({ wallets, settings: { global: global as FleetSettingsV1['global'] } });
    await ready();
    expect(explorerLink('Wallet 0').getAttribute('href')).toBe(
      'https://solscan.io/account/So11111111111111111111111111111111111111112?cluster=devnet',
    );
  });

  it('something that is not an address gets no explorer link', async () => {
    setup(); // Address0, Address1, …
    await ready();
    expect(within(row('W01')).queryByRole('link')).toBeNull();
  });

  it('every tool of a row is a button named after its wallet', async () => {
    setup({ wallets });
    await ready();
    const names = within(row('Wallet 1'))
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label'));
    // As in mockup v2: the short address opens the QR code; Buy, Sell and Trade settings on the right
    expect(names).toEqual([
      'QR code Wallet 1',
      'Copy address Wallet 1',
      'Unit of the buy amount Wallet 1: SOL. Switch',
      'Buy Wallet 1',
      'Sell Wallet 1',
      'Trade settings Wallet 1',
    ]);
  });

  it('the QR opener is the short address itself', async () => {
    setup({ wallets });
    await ready();
    const opener = screen.getByRole('button', { name: 'QR code Wallet 1' });
    expect(opener.textContent).toBe(`${SECOND.slice(0, 4)}…${SECOND.slice(-4)}`);
    expect(opener.getAttribute('title')).toBe(SECOND);
  });

  it('the QR code opens in a popover with the address of its wallet; Esc gives the focus back', async () => {
    const { user } = setup({ wallets });
    await ready();
    const opener = screen.getByRole('button', { name: 'QR code Wallet 1' });
    await user.click(opener);
    const popover = screen.getByRole('dialog', { name: 'QR code of Wallet 1' });
    expect(
      within(popover).getByRole('img', { name: `QR code of the address ${SECOND}` }),
    ).toBeTruthy();
    expect(within(popover).getByText(SECOND)).toBeTruthy();
    expect(opener.getAttribute('aria-expanded')).toBe('true');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);

    // one at a time: opening another row closes the first
    await user.click(opener);
    await user.click(screen.getByRole('button', { name: 'QR code Wallet 0' }));
    expect(screen.getAllByRole('img', { name: /^QR code of the address/u })).toHaveLength(1);
    expect(screen.getByRole('img', { name: `QR code of the address ${FIRST}` })).toBeTruthy();
  });
});

describe('selection', () => {
  it('the header checkbox goes none → all → none and shows the mixed state', async () => {
    const { user } = setup({ settings: { active: [{ index: 1, active: false }] } });
    await ready();
    // saved: wallet 1 is off
    expect(selectBox('W01').checked).toBe(true);
    expect(selectBox('W02').checked).toBe(false);
    expect(headerBox().indeterminate).toBe(true);
    expect(headerBox().checked).toBe(false);
    expect(screen.getByText('2 of 3 selected')).toBeTruthy();

    // mixed → all
    await user.click(headerBox());
    expect(['W01', 'W02', 'W03'].map((l) => selectBox(l).checked)).toEqual([true, true, true]);
    expect(headerBox().indeterminate).toBe(false);
    expect(headerBox().checked).toBe(true);
    expect(screen.getByText('3 of 3 selected')).toBeTruthy();

    // all → none
    await user.click(headerBox());
    expect(['W01', 'W02', 'W03'].map((l) => selectBox(l).checked)).toEqual([false, false, false]);
    expect(headerBox().indeterminate).toBe(false);
    expect(headerBox().checked).toBe(false);
    expect(screen.getByText('0 of 3 selected')).toBeTruthy();

    // none → all
    await user.click(headerBox());
    expect(screen.getByText('3 of 3 selected')).toBeTruthy();

    // one row off: mixed again
    await user.click(selectBox('W03'));
    expect(headerBox().indeterminate).toBe(true);
    expect(screen.getByText('2 of 3 selected')).toBeTruthy();
  });

  it('the saved active flags equal the selection', async () => {
    const { user, saved } = setup({ settings: { active: [{ index: 1, active: false }] } });
    await ready();
    await user.click(headerBox()); // all
    await user.click(headerBox()); // none
    await user.click(selectBox('W02')); // only wallet 1
    await user.click(screen.getByRole('button', { name: 'Save table changes' }));
    await screen.findByText(/The selected wallets are saved in the vault/u);
    // wallets without an entry are active (D-019): 0 and 2 are stored as off, 1 is on
    expect(saved[0]?.active).toEqual([
      { index: 0, active: false },
      { index: 2, active: false },
    ]);
  });

  it('a wallet that is not selected is not ready and not counted in the planned buy', async () => {
    const { user } = setup({
      settings: {
        maxSpend: [
          { index: 0, lamports: 100_000_000n },
          { index: 1, lamports: 200_000_000n },
        ],
      },
    });
    await ready();
    expect(summaryValue('Planned buy')).toBe('0.3 SOL');
    await user.click(selectBox('W02'));
    expect(row('W02').dataset.ready).toBe('false');
    expect(summaryValue('Planned buy')).toBe('0.1 SOL');
    expect(summaryValue('Selected')).toBe('2 of 3');
  });
});
