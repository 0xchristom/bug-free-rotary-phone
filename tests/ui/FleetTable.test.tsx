// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/core/errors.ts';
import type { FleetSettingsV1 } from '../../src/core/index.ts';
import { App } from '../../src/ui/App.tsx';
import type { VaultInfo, VaultRequest, VaultStatus } from '../../src/worker/protocol.ts';
import {
  TARGET_LABEL,
  TARGET_WAIT,
  TOKEN_2022_MINT,
  TOKEN_ACCOUNT,
  classifyFake,
  fleetInfo,
  mockStorage,
  mockVault,
} from './fakes.ts';
import { eventually } from './settle.ts';
import { setupUser } from './user.ts';

const SOL = 1_000_000_000n;

/** Column positions of the wallet table. */
const BALANCE = 2;
const TOKEN = 7;

interface Setup {
  readonly count?: number;
  readonly settings?: Partial<FleetSettingsV1>;
  readonly lamports?: (index: number) => bigint;
  readonly probe?: (index: number) => void;
  /** Replaces the wallets of the fake fleet (real-looking addresses, other labels). */
  readonly wallets?: VaultInfo['wallets'];
  /** No balance answer until the test lets it through. */
  readonly holdBalances?: boolean;
}

function setup({
  count = 3,
  settings = {},
  lamports = () => SOL,
  probe,
  wallets,
  holdBalances = false,
}: Setup = {}) {
  const base = fleetInfo(count);
  let info: VaultInfo = {
    ...base,
    ...(wallets ? { wallets } : {}),
    settings: { ...base.settings, ...settings },
  };
  let balanceOf = lamports;
  const status = (): VaultStatus => ({
    locked: false,
    network: info.settings.global.network,
    armed: false,
    info,
    buy: null,
    watch: null,
    groups: [],
  });
  const vault = mockVault(status());
  const saved: Extract<VaultRequest, { type: 'saveSettings' }>['settings'][] = [];
  const added: number[] = [];
  vault.request.mockImplementation((req: VaultRequest) => {
    switch (req.type) {
      case 'status':
      case 'activity':
        return Promise.resolve(status());
      case 'classifyTarget':
        return classifyFake(req.address);
      case 'refreshBalances':
        if (holdBalances) return new Promise(() => undefined);
        if (req.mint === 'NotAMint') return Promise.reject(new AppError('NOT_A_TOKEN_MINT'));
        return Promise.resolve({
          balances: info.wallets.map((w) => ({ index: w.index, lamports: balanceOf(w.index) })),
          ...(req.mint
            ? {
                token: {
                  mint: req.mint,
                  program: 'token-2022',
                  decimals: 6,
                  balances: info.wallets.map((w) => ({
                    index: w.index,
                    amount: BigInt(w.index) * 1_500_000n,
                  })),
                },
              }
            : {}),
          network: info.settings.global.network,
          source: 'helius',
          fetchedAt: '2026-10-02T12:00:00.000Z',
        });
      case 'saveSettings': {
        // like the worker: without trade parameters or groups the current ones stay
        saved.push(req.settings);
        info = {
          ...info,
          settings: {
            ...req.settings,
            trade: req.settings.trade ?? info.settings.trade,
            groups: req.settings.groups ?? info.settings.groups,
          },
        };
        return Promise.resolve({ fileText: '{"saved":true}', info });
      }
      case 'addWallets': {
        added.push(req.count);
        const more = Array.from({ length: req.count }, (_, i) => {
          const index = info.wallets.length + i;
          return {
            index,
            address: `Address${String(index)}`,
            derivationPath: `m/44'/501'/${String(index)}'/0'`,
            label: `Wallet ${String(index)}`,
          };
        });
        info = { ...info, wallets: [...info.wallets, ...more] };
        return Promise.resolve({ fileText: '{"added":true}', info });
      }
      default:
        return Promise.reject(new AppError('INTERNAL_ERROR'));
    }
  });
  const storage = mockStorage();
  render(
    <App
      vault={vault.client}
      storage={storage.env}
      statusPollMs={60_000}
      balanceRefreshMs={60_000}
      {...(probe ? { rowProbe: probe } : {})}
    />,
  );
  return {
    vault,
    saved,
    added,
    storage,
    user: setupUser(),
    setBalances: (f: (index: number) => bigint) => {
      balanceOf = f;
    },
  };
}

/**
 * The wallet's row, found by its selection checkbox. A plain DOM query: a role query with a
 * name works out the name of every element on a page of 100 rows (BUNNDLY-65).
 */
function row(label: string): HTMLElement {
  const tr = document.querySelector(`input[aria-label="Select ${label}"]`)?.closest('tr');
  if (!tr) throw new Error(`row ${label}`);
  return tr;
}

/**
 * Waits until the first balance read is on screen. A hundred rows take jsdom over a second
 * to build, so the wait is longer than the default one.
 */
async function ready(): Promise<void> {
  await eventually(() => screen.getByText(/^Balances as of /u));
}

function cells(label: string): string[] {
  return [...row(label).children].map((c) => c.textContent);
}

function selectBox(label: string): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>('checkbox', { name: `Select ${label}` });
}

function headerBox(): HTMLInputElement {
  return screen.getByRole<HTMLInputElement>('checkbox', { name: 'Select all wallets' });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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
    expect(within(row('W01')).getByText('Ready')).toBeTruthy();
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
    await user.type(screen.getByLabelText(TARGET_LABEL), TOKEN_ACCOUNT);
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
    await user.type(screen.getByLabelText(TARGET_LABEL), TOKEN_ACCOUNT);
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

describe('100 wallets', () => {
  it('a balance refresh re-renders only the rows whose balance changed', async () => {
    const renders = new Map<number, number>();
    const probe = (index: number): void => {
      renders.set(index, (renders.get(index) ?? 0) + 1);
    };
    const { user, setBalances } = setup({ count: 100, probe });
    await ready();
    await waitFor(() => {
      expect(cells('W100')[BALANCE]).toBe('1');
    });
    expect(renders.size).toBe(100);
    const before = new Map(renders);

    // same balances: no row renders again
    await user.click(screen.getByRole('button', { name: /^Fleet balance:/u }));
    await act(() => Promise.resolve());
    expect(renders).toEqual(before);

    // one wallet changed: only that row renders, once
    setBalances((i) => (i === 42 ? 2n * SOL : SOL));
    await user.click(screen.getByRole('button', { name: /^Fleet balance:/u }));
    // 1 SOL before, 2 after: "+1" under it, written on the element, not a second render
    await waitFor(() => {
      expect(cells('W43')[BALANCE]).toBe('2+1');
    });
    const changed = [...renders].filter(([i, n]) => n !== before.get(i)).map(([i]) => i);
    expect(changed).toEqual([42]);
    expect(renders.get(42)).toBe((before.get(42) ?? 0) + 1);
  }, 30_000);

  it('a filter or a search that keeps a row on screen does not render it again', async () => {
    const renders = new Map<number, number>();
    const probe = (index: number): void => {
      renders.set(index, (renders.get(index) ?? 0) + 1);
    };
    const { user } = setup({ count: 100, probe });
    await ready();
    await waitFor(() => {
      expect(cells('W100')[BALANCE]).toBe('1');
    });
    renders.clear();
    // every wallet is selected: the Selected tab shows the same 100 rows
    fireEvent.click(document.querySelector('.tabs button:nth-child(2)') ?? document.body);
    expect(document.querySelectorAll('tbody tr')).toHaveLength(100);
    expect(renders.size).toBe(0);
    // W10 and W100 match "W10": the other rows leave, these two stay without a render
    const search = document.querySelector<HTMLInputElement>('input[type="search"]');
    if (!search) throw new Error('search');
    await user.type(search, 'W10');
    expect(document.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(renders.size).toBe(0);
  }, 30_000);
});

function summaryValue(term: string): string {
  const dl = screen.getByLabelText('Fleet summary');
  const dt = within(dl).getByText(term);
  return dt.nextElementSibling?.textContent ?? '';
}

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

describe('summary', () => {
  it('the summary sums token balances with decimals', async () => {
    const { user } = setup();
    await ready();
    expect(summaryValue('Tokens held')).toBe('—');
    await user.type(screen.getByLabelText(TARGET_LABEL), TOKEN_2022_MINT);
    await screen.findByRole('columnheader', { name: 'Tokens (Token-2022)' }, TARGET_WAIT);
    expect(summaryValue('Tokens held')).toBe('4.5'); // 0 + 1.5 + 3
  });
});

describe('filters, search and sorting (mockup v2)', () => {
  /** Wallet labels in the order the table shows them. */
  function shownLabels(): string[] {
    return [...document.querySelectorAll('tbody tr .w-name')].map((b) => b.textContent);
  }

  it('the tabs count their wallets; Selected shows only the selected ones', async () => {
    const { user } = setup({ settings: { active: [{ index: 1, active: false }] } });
    await ready();
    const tabs = within(screen.getByRole('group', { name: 'Wallet filters' }));
    expect(tabs.getAllByRole('button').map((b) => b.textContent)).toEqual([
      'All wallets 3',
      'Selected 2',
      'In flight 0',
      'Filled 0',
      'Needs attention 0',
    ]);
    await user.click(tabs.getByRole('button', { name: 'Selected 2' }));
    expect(tabs.getByRole('button', { name: 'Selected 2' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(shownLabels()).toEqual(['W01', 'W03']);
    await user.click(tabs.getByRole('button', { name: 'Needs attention 0' }));
    expect(shownLabels()).toEqual([]);
    expect(screen.getByText('No wallet matches the filter.')).toBeTruthy();
  });

  it('a too small reserve puts the wallet under Needs attention', async () => {
    setup({ settings: { maxSpend: [{ index: 2, lamports: 990_000_000n }] } });
    await ready();
    // 1 SOL − 0.99 SOL = 0.01 SOL < 0.015 SOL
    expect(screen.getByRole('button', { name: 'Needs attention 1' })).toBeTruthy();
  });

  it('the search finds a wallet by its name or its address', async () => {
    const { user } = setup();
    await ready();
    const search = screen.getByRole('searchbox', { name: 'Search wallets' });
    await user.type(search, 'w02');
    expect(shownLabels()).toEqual(['W02']);
    await user.clear(search);
    await user.type(search, 'Address2'); // the address of the third wallet
    expect(shownLabels()).toEqual(['W03']);
    await user.clear(search);
    expect(shownLabels()).toEqual(['W01', 'W02', 'W03']);
  });

  it('a click on Balance sorts the largest first, a second click turns it round', async () => {
    const { user } = setup({ lamports: (i) => [2n * SOL, 3n * SOL, SOL][i] ?? 0n });
    await ready();
    const header = screen.getByRole('columnheader', { name: 'Balance (SOL)' });
    expect(header.getAttribute('aria-sort')).toBe('none');
    await user.click(within(header).getByRole('button'));
    expect(header.getAttribute('aria-sort')).toBe('descending');
    expect(shownLabels()).toEqual(['W02', 'W01', 'W03']);
    await user.click(within(header).getByRole('button'));
    expect(header.getAttribute('aria-sort')).toBe('ascending');
    expect(shownLabels()).toEqual(['W03', 'W01', 'W02']);
  });

  it('a click on Buy amount sorts by what a buy would spend, empty ones last', async () => {
    const { user } = setup({
      lamports: () => 2n * SOL,
      settings: {
        maxSpend: [{ index: 2, lamports: 100_000_000n }],
        trade: {
          fleet: fleetInfo().settings.trade.fleet,
          // 2 % of 2 SOL = 0.04 SOL: between the other two
          wallets: [{ index: 0, buyPercent: 2 }],
        },
      },
    });
    await ready();
    const header = screen.getByRole('columnheader', { name: 'Buy amount (SOL or % of balance)' });
    await user.click(within(header).getByRole('button'));
    expect(shownLabels()).toEqual(['W03', 'W01', 'W02']);
  });

  it('the header checkbox selects only the wallets the filter and the search show', async () => {
    const { user } = setup();
    await ready();
    await user.type(screen.getByRole('searchbox', { name: 'Search wallets' }), 'W02');
    expect(headerBox().checked).toBe(true);
    // the count is of the whole fleet, not of what the search shows
    expect(screen.getByText('3 of 3 selected')).toBeTruthy();
    await user.click(headerBox()); // clears W02 only
    await user.clear(screen.getByRole('searchbox', { name: 'Search wallets' }));
    expect(['W01', 'W02', 'W03'].map((l) => selectBox(l).checked)).toEqual([true, false, true]);
    expect(screen.getByText('2 of 3 selected')).toBeTruthy();
  });
});
