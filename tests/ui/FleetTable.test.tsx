// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/core/errors.ts';
import type { FleetSettingsV1 } from '../../src/core/index.ts';
import { App } from '../../src/ui/App.tsx';
import type { VaultInfo, VaultRequest, VaultStatus } from '../../src/worker/protocol.ts';
import { fleetInfo, mockStorage, mockVault } from './fakes.ts';

const SOL = 1_000_000_000n;

interface Setup {
  readonly count?: number;
  readonly settings?: Partial<FleetSettingsV1>;
  readonly lamports?: (index: number) => bigint;
  readonly probe?: (index: number) => void;
}

function setup({ count = 3, settings = {}, lamports = () => SOL, probe }: Setup = {}) {
  const base = fleetInfo(count);
  let info: VaultInfo = { ...base, settings: { ...base.settings, ...settings } };
  let balanceOf = lamports;
  const status = (): VaultStatus => ({ locked: false, armed: false, info });
  const vault = mockVault(status());
  const saved: FleetSettingsV1[] = [];
  vault.request.mockImplementation((req: VaultRequest) => {
    switch (req.type) {
      case 'status':
      case 'activity':
        return Promise.resolve(status());
      case 'refreshBalances':
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
          source: 'helius',
          fetchedAt: '2026-10-02T12:00:00.000Z',
        });
      case 'saveSettings': {
        saved.push(req.settings);
        info = { ...info, settings: req.settings };
        return Promise.resolve({ fileText: '{"saved":true}', info });
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
    storage,
    user: userEvent.setup(),
    setBalances: (f: (index: number) => bigint) => {
      balanceOf = f;
    },
  };
}

function row(label: string): HTMLElement {
  const cell = screen.getByRole('cell', { name: label });
  const tr = cell.closest('tr');
  if (!tr) throw new Error('row');
  return tr;
}

/** Waits until the first balance read is on screen. */
async function ready(): Promise<void> {
  await screen.findByText(/^Salda z /u);
}

function cells(label: string): string[] {
  return within(row(label))
    .getAllByRole('cell')
    .map((c) => c.textContent);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('fleet table', () => {
  it('shows balance, max spend, reserve and readiness; a too small reserve is red', async () => {
    const { user } = setup({
      settings: {
        maxSpend: [
          { index: 0, lamports: 985_000_000n }, // reserve exactly 0.015
          { index: 1, lamports: 985_000_001n }, // one lamport short
        ],
      },
    });
    await ready();
    expect(within(row('W01')).getByLabelText<HTMLInputElement>('Max spend W01').value).toBe(
      '0,985',
    );
    expect(row('W01').dataset.ready).toBe('true');
    expect(within(row('W01')).getByText('0,015')).toBeTruthy();
    expect(row('W02').className).toBe('row-error');
    expect(row('W02').dataset.ready).toBe('false');
    expect(within(row('W02')).getByText('za mała')).toBeTruthy();
    // no max spend: neither ready nor red
    expect(row('W03').dataset.ready).toBe('false');
    expect(row('W03').className).toBe('');

    await user.clear(within(row('W03')).getByLabelText('Max spend W03'));
    await user.type(within(row('W03')).getByLabelText('Max spend W03'), '2');
    expect(within(row('W03')).getByText('Więcej niż saldo portfela.')).toBeTruthy();
    expect(row('W03').className).toBe('row-error');
  });

  it('invalid amounts show Polish messages and block saving', async () => {
    const { user } = setup();
    await ready();
    const input = within(row('W01')).getByLabelText('Max spend W01');
    for (const [text, message] of [
      ['-1', 'Kwota nie może być ujemna.'],
      ['0,1234567891', 'Podaj najwyżej 9 miejsc po przecinku (1 lamport).'],
      ['dużo', 'Podaj kwotę w SOL, np. 0,25.'],
    ] as const) {
      await user.clear(input);
      await user.type(input, text);
      expect(within(row('W01')).getByText(message)).toBeTruthy();
      expect(
        screen.getByRole<HTMLButtonElement>('button', { name: 'Zapisz zmiany w tabeli' }).disabled,
      ).toBe(true);
    }
  });

  it('saves max spend and active flags through the vault, then the file on click', async () => {
    const { user, saved, storage } = setup();
    await ready();
    await user.type(within(row('W01')).getByLabelText('Max spend W01'), '0.5');
    await user.type(within(row('W03')).getByLabelText('Max spend W03'), '0,25');
    await user.click(within(row('W02')).getByLabelText('Aktywny W02'));
    expect(screen.getByText('Masz niezapisane zmiany w tabeli.')).toBeTruthy();

    // unsaved edits are protected like an unsaved file
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Zapisz zmiany w tabeli' }));
    await screen.findByText(/Zmiany w tabeli .* są zapisane w sejfie/u);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toEqual({
      maxSpend: [
        { index: 0, lamports: 500_000_000n },
        { index: 2, lamports: 250_000_000n },
      ],
      active: [{ index: 1, active: false }],
      global: fleetInfo().settings.global,
    });
    expect(storage.showDirectoryPicker).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Zapisz zaktualizowany plik floty' }));
    expect(await screen.findByText(/z nowymi ustawieniami floty/u)).toBeTruthy();
    expect(storage.files.get('Flota testowa.keystore.json')).toBe('{"saved":true}');
    expect(screen.queryByText('Masz niezapisane zmiany w tabeli.')).toBeNull();
  });

  it('a token mint shows balances with decimals; a wrong mint shows a Polish error', async () => {
    const { user } = setup();
    await ready();
    await user.type(screen.getByLabelText('Adres tokenu (mint)'), 'SomeMint111');
    await user.click(screen.getByRole('button', { name: 'Pokaż saldo tokenu' }));
    expect(await screen.findByRole('columnheader', { name: 'Token (Token-2022)' })).toBeTruthy();
    expect(cells('W02')[6]).toBe('1,5');
    expect(cells('W03')[6]).toBe('3');

    await user.clear(screen.getByLabelText('Adres tokenu (mint)'));
    await user.type(screen.getByLabelText('Adres tokenu (mint)'), 'NotAMint');
    await user.click(screen.getByRole('button', { name: 'Pokaż saldo tokenu' }));
    // the message sits at the field, the table stays
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('nie jest mintem tokenu');
    expect(alert.id).toBe(
      screen.getByLabelText('Adres tokenu (mint)').getAttribute('aria-describedby'),
    );
    expect(screen.getByRole('columnheader', { name: 'Token' })).toBeTruthy();
    expect(screen.getByRole('table')).toBeTruthy();
  });

  it('after a wrong mint the SOL balances keep refreshing (without the mint)', async () => {
    const { user, vault, setBalances } = setup();
    await ready();
    await user.type(screen.getByLabelText('Adres tokenu (mint)'), 'NotAMint');
    await user.click(screen.getByRole('button', { name: 'Pokaż saldo tokenu' }));
    await screen.findByRole('alert');
    const refreshes = (): { mint?: string }[] =>
      vault.request.mock.calls.map(([r]) => r).filter((r) => r.type === 'refreshBalances');
    // right after the error it refreshes again without the mint
    await waitFor(() => {
      expect(refreshes().at(-1)?.mint).toBeUndefined();
    });
    setBalances(() => 3n * SOL);
    await user.click(screen.getByRole('button', { name: 'Odśwież salda' }));
    await waitFor(() => {
      expect(cells('W01')[3]).toBe('3');
    });
    expect(refreshes().at(-1)?.mint).toBeUndefined();
    expect(screen.getByRole('alert').textContent).toContain('nie jest mintem tokenu');

    // a corrected mint clears the message and reads the token again
    await user.clear(screen.getByLabelText('Adres tokenu (mint)'));
    await user.type(screen.getByLabelText('Adres tokenu (mint)'), 'GoodMint1');
    await user.click(screen.getByRole('button', { name: 'Pokaż saldo tokenu' }));
    expect(await screen.findByRole('columnheader', { name: 'Token (Token-2022)' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('settings reset while reading the file are announced', async () => {
    setup({ settings: { resetFields: ['minReserveLamports', 'maxAttempts'] } });
    await ready();
    expect(
      screen.getByText(/przyjęły wartości domyślne: minimalna rezerwa, liczba prób/u),
    ).toBeTruthy();
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
      expect(cells('W100')[3]).toBe('1');
    });
    expect(renders.size).toBe(100);
    const before = new Map(renders);

    // same balances: no row renders again
    await user.click(screen.getByRole('button', { name: 'Odśwież salda' }));
    await act(() => Promise.resolve());
    expect(renders).toEqual(before);

    // one wallet changed: only that row renders
    setBalances((i) => (i === 42 ? 2n * SOL : SOL));
    await user.click(screen.getByRole('button', { name: 'Odśwież salda' }));
    await waitFor(() => {
      expect(cells('W43')[3]).toBe('2');
    });
    const changed = [...renders].filter(([i, n]) => n !== before.get(i)).map(([i]) => i);
    expect(changed).toEqual([42]);
  });
});

describe('bulk actions and summary', () => {
  function summaryValue(term: string): string {
    const dl = screen.getByLabelText('Podsumowanie floty');
    const dt = within(dl).getByText(term);
    return dt.nextElementSibling?.textContent ?? '';
  }

  it('sets the same max spend on all wallets (drafts only, saved on click)', async () => {
    const { user, saved } = setup();
    await ready();
    await user.type(screen.getByLabelText('Max spend dla wszystkich (SOL)'), '0,5');
    await user.click(screen.getByRole('button', { name: 'Ustaw kwotę' }));
    for (const label of ['W01', 'W02', 'W03']) {
      expect(within(row(label)).getByLabelText<HTMLInputElement>(`Max spend ${label}`).value).toBe(
        '0,5',
      );
    }
    expect(saved).toHaveLength(0);
    expect(summaryValue('Gotowe portfele')).toBe('3 / 3');
    expect(summaryValue('Łącznie do wydania')).toBe('1,5 SOL');
    expect(summaryValue('Łącznie SOL')).toBe('3 SOL');
  });

  it('a wrong amount or percent gives a Polish message and changes nothing', async () => {
    const { user } = setup();
    await ready();
    await user.type(screen.getByLabelText('Max spend dla wszystkich (SOL)'), '-1');
    await user.click(screen.getByRole('button', { name: 'Ustaw kwotę' }));
    expect(screen.getByText('Kwota nie może być ujemna.')).toBeTruthy();
    await user.type(screen.getByLabelText('Max spend jako % salda'), '150');
    await user.click(screen.getByRole('button', { name: 'Ustaw procent' }));
    expect(screen.getByText(/Podaj procent salda od 0,01 do 100/u)).toBeTruthy();
    expect(within(row('W01')).getByLabelText<HTMLInputElement>('Max spend W01').value).toBe('');
  });

  it('sets max spend as a % of each balance (rounded down)', async () => {
    const { user } = setup({ lamports: (i) => SOL + BigInt(i) * 333n });
    await ready();
    await user.type(screen.getByLabelText('Max spend jako % salda'), '90');
    await user.click(screen.getByRole('button', { name: 'Ustaw procent' }));
    expect(within(row('W01')).getByLabelText<HTMLInputElement>('Max spend W01').value).toBe('0,9');
    // (1 000 000 333 × 9000) / 10 000 = 900 000 299.7 → 900 000 299 lamports
    expect(within(row('W02')).getByLabelText<HTMLInputElement>('Max spend W02').value).toBe(
      '0,900000299',
    );
    // reserve = balance − 90 % ≥ 0.015 SOL, so every wallet is ready
    expect(summaryValue('Gotowe portfele')).toBe('3 / 3');
  });

  it('select and deselect all', async () => {
    const { user } = setup();
    await ready();
    await user.click(screen.getByRole('button', { name: 'Odznacz wszystkie' }));
    for (const label of ['W01', 'W02', 'W03']) {
      expect(within(row(label)).getByLabelText<HTMLInputElement>(`Aktywny ${label}`).checked).toBe(
        false,
      );
    }
    await user.click(screen.getByRole('button', { name: 'Zaznacz wszystkie' }));
    expect(within(row('W02')).getByLabelText<HTMLInputElement>('Aktywny W02').checked).toBe(true);
  });

  it('the summary sums token balances with decimals', async () => {
    const { user } = setup();
    await ready();
    expect(summaryValue('Łącznie tokenów')).toBe('–');
    await user.type(screen.getByLabelText('Adres tokenu (mint)'), 'SomeMint111');
    await user.click(screen.getByRole('button', { name: 'Pokaż saldo tokenu' }));
    await screen.findByRole('columnheader', { name: 'Token (Token-2022)' });
    expect(summaryValue('Łącznie tokenów')).toBe('4,5'); // 0 + 1.5 + 3
  });
});
