// @vitest-environment jsdom
/**
 * The Fill column, the fleet fill segments (BUNNDLY-56) and the Stairs strip with Pause /
 * Resume in the toolbar (BUNNDLY-61 part 2) on the fleet screen. Every expected number and
 * text is written out by hand from the task's list (fill.ts carries the same list), never
 * read from the code under test.
 */
import { readFileSync } from 'node:fs';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  RunEvent,
  StairsOptions,
  VerifyEvent,
  WalletEvent,
} from '../../src/executor/index.ts';
import { App } from '../../src/ui/App.tsx';
import type { VaultInfo, VaultRequest, VaultStatus } from '../../src/worker/protocol.ts';
import {
  TARGET_LABEL,
  TARGET_WAIT,
  classifyFake,
  fleetInfo,
  mockStorage,
  mockVault,
  withDefaultGroup,
} from './fakes.ts';
import { eventually } from './settle.ts';
import { setupUser } from './user.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL = 1_000_000_000n;

function setup({ dryRun = true }: { readonly dryRun?: boolean } = {}) {
  const base = fleetInfo(3);
  const info: VaultInfo = {
    ...base,
    settings: {
      ...base.settings,
      maxSpend: base.wallets.map((w) => ({ index: w.index, lamports: 10_000_000n })),
      global: { ...base.settings.global, dryRun },
    },
    apiKeys: { ...base.apiKeys, helius: true },
  };
  let buy: VaultStatus['buy'] = null;
  const status = (): VaultStatus => ({
    locked: false,
    network: info.settings.global.network,
    armed: buy !== null,
    info,
    buy,
    watch: null,
    groups: [],
  });
  const vault = mockVault(status());
  const requests: VaultRequest[] = [];
  vault.request.mockImplementation((req: VaultRequest) => {
    requests.push(req);
    switch (req.type) {
      case 'status':
      case 'activity':
        return Promise.resolve(withDefaultGroup(status()));
      case 'refreshBalances':
        return Promise.resolve({
          balances: info.wallets.map((w) => ({ index: w.index, lamports: SOL })),
          ...(req.mint
            ? {
                token: {
                  mint: req.mint,
                  program: 'spl-token',
                  decimals: 6,
                  balances: info.wallets.map((w) => ({ index: w.index, amount: 0n })),
                },
              }
            : {}),
          network: info.settings.global.network,
          source: 'helius',
          fetchedAt: '2026-10-14T12:00:00.000Z',
        });
      case 'classifyTarget':
        return classifyFake(req.address);
      case 'startBuy':
      case 'startSell':
        buy = {
          runId: 1,
          mint: req.mint,
          dryRun,
          wallets: 3,
          accepting: true,
          ...(req.stairs ? { stairs: req.stairs, paused: false } : {}),
        };
        return Promise.resolve({ ...buy });
      case 'pauseStairs':
        if (buy) buy = { ...buy, paused: true };
        return Promise.resolve(withDefaultGroup(status()));
      case 'resumeStairs':
        if (buy) buy = { ...buy, paused: false };
        return Promise.resolve(withDefaultGroup(status()));
      case 'stop':
        if (buy) buy = { ...buy, accepting: false };
        return Promise.resolve(withDefaultGroup(status()));
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
  return { vault, requests, user: setupUser() };
}

function runEvent(
  phase: RunEvent['phase'],
  dryRun: boolean,
  stairs?: StairsOptions & { paused: boolean },
): RunEvent {
  return {
    kind: 'run',
    runId: 1,
    at: 0,
    phase,
    mint: MINT,
    dryRun,
    wallets: 3,
    counts: {
      IDLE: 0,
      SCHEDULED: 0,
      QUEUED: 0,
      QUOTING: 0,
      SIGNING: 0,
      SUBMITTED: 0,
      CONFIRMED: 0,
      FAILED: 0,
      UNKNOWN: 0,
      SKIPPED: 0,
    },
    ...(stairs
      ? {
          stairs: {
            intervalMs: stairs.intervalMs,
            perStep: stairs.perStep,
            step: 1,
            steps: 3,
            paused: stairs.paused,
            nextStepAt: null,
          },
        }
      : {}),
  };
}

function walletEvent(
  index: number,
  state: WalletEvent['state'],
  extra: Partial<WalletEvent> = {},
): WalletEvent {
  return {
    kind: 'wallet',
    runId: 1,
    at: 0,
    index,
    state,
    attempt: 1,
    reason: null,
    quote: null,
    result: null,
    times: { orderMs: null, signMs: null, executeMs: null, sinceStartMs: 1_500 },
    ...extra,
  };
}

function verifyEvent(index: number, status: VerifyEvent['status']): VerifyEvent {
  return { kind: 'verify', runId: 1, at: 0, index, status, expected: null, observed: null };
}

async function showMint(user: UserEvent): Promise<void> {
  await eventually(() => screen.getByText(/^Balances as of /u));
  await user.type(screen.getByLabelText(TARGET_LABEL), MINT);
  await screen.findByRole('columnheader', { name: 'Tokens (SPL)' }, TARGET_WAIT);
}

/** The Fill bar of a wallet: its value and its text. */
function fillOf(label: string): { readonly now: string | null; readonly text: string | null } {
  const bar = screen.getByRole('progressbar', { name: `Fill of ${label}` });
  return { now: bar.getAttribute('aria-valuenow'), text: bar.getAttribute('aria-valuetext') };
}

/** The rail's message line (BUNNDLY-90). */
const said = (): string => screen.getByRole('status', { name: 'Last command' }).textContent;

/** Every request the app sent to the fake worker. */
function requests(vault: ReturnType<typeof mockVault>): VaultRequest[] {
  return vault.request.mock.calls.map(([r]) => r);
}

function segmentTones(): (string | undefined)[] {
  const segs = screen.getByTestId('fleet-segments');
  return [...segs.querySelectorAll('i')].map((i) => i.dataset.tone);
}

function toolbar(): HTMLElement {
  const bar = document.querySelector<HTMLElement>('.table-bar');
  if (!bar) throw new Error('no toolbar');
  return bar;
}

describe('Fill column and fleet fill (BUNNDLY-56)', () => {
  // BUNNDLY-85: the bar's inner `.top` took the app header's rule (min-height 58 px, padding,
  // border), so a row was 88 px instead of about 68. No class inside the bar may be one that
  // base.css styles on its own, outside `.fill`.
  it('no element of the fill bar has a class that base.css styles globally (e.g. the header .top)', async () => {
    const { user } = setup();
    await showMint(user);
    const bar = screen.getByRole('progressbar', { name: 'Fill of W01' });
    const inner = [...bar.querySelectorAll('*')].flatMap((el) => [...el.classList]);
    expect(inner.length).toBeGreaterThan(0);
    expect(inner).not.toContain('top');
    // a rule whose selector starts with the bare class, e.g. ".top {" or ".cap,"
    const css = readFileSync('src/ui/base.css', 'utf8');
    const global = new Set(
      [...css.matchAll(/(?:^|[},]\s*)\.([a-z][\w-]*)(?=[\s,{:[])/gu)].map((m) => m[1]),
    );
    expect(inner.filter((c) => global.has(c))).toEqual([]);
  });

  it('live: Verifying at 90 until the chain read, Filled at 100 after MATCH; failed at 0', async () => {
    const { vault, user } = setup({ dryRun: false });
    await showMint(user);
    // before any buy the bar is empty, without a stage
    expect(fillOf('W01')).toEqual({ now: '0', text: '0%' });
    act(() => {
      vault.emit(runEvent('started', false));
      vault.emit(walletEvent(0, 'CONFIRMED'));
      vault.emit(walletEvent(1, 'SUBMITTED'));
      vault.emit(
        walletEvent(2, 'FAILED', {
          reason: { kind: 'FAILED', code: 'NO_ROUTE', detail: null },
        }),
      );
    });
    await eventually(() => {
      expect(fillOf('W01')).toEqual({ now: '90', text: '90%, Verifying' });
    });
    expect(fillOf('W02')).toEqual({ now: '60', text: '60%, Sent' });
    expect(fillOf('W03').now).toBe('0');
    expect(screen.getByRole('progressbar', { name: 'Fill of W03' }).dataset.tone).toBe('bad');
    // one segment per selected wallet: CONFIRMED before the read is still in flight
    expect(segmentTones()).toEqual(['run', 'run', 'bad']);
    expect(screen.getByText(/^Fleet fill · 0 of 3 filled · 2 in flight · 1 failed$/u)).toBeTruthy();
    act(() => {
      vault.emit(verifyEvent(0, 'MATCH'));
    });
    await eventually(() => {
      expect(fillOf('W01')).toEqual({ now: '100', text: '100%, Filled' });
    });
    expect(segmentTones()).toEqual(['ok', 'run', 'bad']);
    expect(screen.getByText(/^Fleet fill · 1 of 3 filled · 1 in flight · 1 failed$/u)).toBeTruthy();
  });

  it('a chain read that disagrees is never green: MISMATCH amber, NO_INCREASE red', async () => {
    const { vault, user } = setup({ dryRun: false });
    await showMint(user);
    act(() => {
      vault.emit(runEvent('started', false));
      vault.emit(walletEvent(0, 'CONFIRMED'));
      vault.emit(walletEvent(1, 'CONFIRMED'));
      vault.emit(verifyEvent(0, 'MISMATCH'));
      vault.emit(verifyEvent(1, 'NO_INCREASE'));
    });
    await eventually(() => {
      expect(fillOf('W01')).toEqual({ now: '100', text: '100%, Amount differs' });
    });
    expect(fillOf('W02')).toEqual({ now: '0', text: '0%, Not on chain' });
    const tones = ['W01', 'W02'].map(
      (w) => screen.getByRole('progressbar', { name: `Fill of ${w}` }).dataset.tone,
    );
    expect(tones).toEqual(['warn', 'bad']);
    expect(segmentTones()).toEqual(['warn', 'bad', 'idle']);
  });

  it('DRY-RUN: Simulated, never Filled and never green', async () => {
    const { vault, user } = setup({ dryRun: true });
    await showMint(user);
    act(() => {
      vault.emit(runEvent('started', true));
      for (const i of [0, 1, 2]) {
        vault.emit(
          walletEvent(i, 'SKIPPED', {
            reason: { kind: 'SKIPPED', code: 'DRY_RUN', detail: null },
          }),
        );
      }
    });
    await eventually(() => {
      expect(fillOf('W01')).toEqual({ now: '100', text: '100%, Simulated' });
    });
    expect(screen.queryByText('Filled', { selector: '.fill-cap' })).toBeNull();
    expect(segmentTones()).toEqual(['sim', 'sim', 'sim']);
  });

  // BUNNDLY-93: the fleet fill is there before the first run, every segment grey
  it('before any run: "0 of 3 filled" over 3 grey segments', async () => {
    const { user } = setup();
    await showMint(user);
    expect(screen.getByText(/^Fleet fill · 0 of 3 filled$/u)).toBeTruthy();
    expect(segmentTones()).toEqual(['idle', 'idle', 'idle']);
    expect(screen.queryByText(/no buy or sell yet/u)).toBeNull();
    await user.click(screen.getByRole('checkbox', { name: 'Select W03' }));
    expect(screen.getByText(/^Fleet fill · 0 of 2 filled$/u)).toBeTruthy();
    expect(segmentTones()).toEqual(['idle', 'idle']);
  });

  it('the segments follow the selection: one per selected wallet', async () => {
    const { vault, user } = setup();
    await showMint(user);
    act(() => {
      vault.emit(runEvent('started', true));
      vault.emit(walletEvent(0, 'QUEUED'));
    });
    await eventually(() => {
      expect(segmentTones()).toEqual(['run', 'idle', 'idle']);
    });
    await user.click(screen.getByRole('checkbox', { name: 'Select W02' }));
    expect(segmentTones()).toEqual(['run', 'idle']);
    expect(screen.getByText(/^Fleet fill · 0 of 2 filled · 1 in flight$/u)).toBeTruthy();
  });
});

/** The state chip in the Status column of a wallet: its text and its tone. */
function chipOf(label: string): { readonly text: string; readonly tone: string | undefined } {
  const bar = screen.getByRole('progressbar', { name: `Fill of ${label}` });
  const row = bar.closest('tr');
  const chip = row?.querySelector<HTMLElement>('.c-status .k-chip');
  if (!chip) throw new Error(`no state chip in ${label}`);
  return { text: chip.textContent.trim(), tone: chip.dataset.tone };
}

describe('state chip: Sold, Stopped, Retrying (BUNNDLY-89)', () => {
  it('a confirmed sell says Sold; a confirmed buy still says Bought', async () => {
    const { vault, user } = setup({ dryRun: false });
    await showMint(user);
    act(() => {
      vault.emit({ ...runEvent('started', false), side: 'sell' });
      vault.emit(walletEvent(0, 'CONFIRMED'));
    });
    await eventually(() => {
      expect(chipOf('W01')).toEqual({ text: 'Sold', tone: 'ok' });
    });
    act(() => {
      vault.emit({ ...runEvent('started', false), runId: 2, side: 'buy' });
      vault.emit({ ...walletEvent(0, 'CONFIRMED'), runId: 2 });
    });
    await eventually(() => {
      expect(chipOf('W01')).toEqual({ text: 'Bought', tone: 'ok' });
    });
  });

  it('skipped by STOP says Stopped in amber; other skips stay muted Skipped', async () => {
    const { vault, user } = setup({ dryRun: false });
    await showMint(user);
    act(() => {
      vault.emit(runEvent('started', false));
      vault.emit(
        walletEvent(0, 'SKIPPED', { reason: { kind: 'SKIPPED', code: 'STOPPED', detail: null } }),
      );
      vault.emit(
        walletEvent(1, 'SKIPPED', {
          reason: { kind: 'SKIPPED', code: 'INSUFFICIENT_SOL', detail: null },
        }),
      );
    });
    await eventually(() => {
      expect(chipOf('W01')).toEqual({ text: 'Stopped', tone: 'warn' });
    });
    expect(chipOf('W02')).toEqual({ text: 'Skipped', tone: 'muted' });
  });

  it('back in the queue after an attempt says Retrying; the 2nd attempt is named in Fill', async () => {
    const { vault, user } = setup({ dryRun: false });
    await showMint(user);
    act(() => {
      vault.emit(runEvent('started', false));
      vault.emit(walletEvent(0, 'QUEUED', { attempt: 0 }));
      vault.emit(walletEvent(1, 'QUEUED', { attempt: 1 }));
      vault.emit(walletEvent(2, 'QUOTING', { attempt: 2 }));
    });
    await eventually(() => {
      expect(chipOf('W02')).toEqual({ text: 'Retrying', tone: 'warn' });
    });
    expect(chipOf('W01')).toEqual({ text: 'Queued', tone: 'run' });
    expect(fillOf('W01')).toEqual({ now: '5', text: '5%, Queued' });
    expect(fillOf('W02')).toEqual({ now: '5', text: '5%, Retrying' });
    expect(fillOf('W03')).toEqual({ now: '20', text: '20%, Quote · 2nd attempt' });
    expect(chipOf('W03')).toEqual({ text: 'Quoting', tone: 'run' });
  });
});

/** The state chip element of a wallet. */
function chipEl(label: string): HTMLElement {
  const bar = screen.getByRole('progressbar', { name: `Fill of ${label}` });
  const chip = bar.closest('tr')?.querySelector<HTMLElement>('.c-status .k-chip');
  if (!chip) throw new Error(`no state chip in ${label}`);
  return chip;
}

describe('state chip words of mockup v2 (BUNNDLY-94)', () => {
  it('Filled only for a buy the Filled tab counts; Bought before or against the chain read', async () => {
    const { vault, user } = setup({ dryRun: false });
    await showMint(user);
    act(() => {
      vault.emit(runEvent('started', false));
      for (const i of [0, 1, 2]) vault.emit(walletEvent(i, 'CONFIRMED'));
    });
    // CONFIRMED by Jupiter, no chain read yet: not in the Filled tab, so not "Filled"
    await eventually(() => {
      expect(chipOf('W01')).toEqual({ text: 'Bought', tone: 'ok' });
    });
    act(() => {
      vault.emit(verifyEvent(0, 'MATCH'));
      vault.emit(verifyEvent(1, 'INCREASED'));
      vault.emit(verifyEvent(2, 'MISMATCH'));
    });
    await eventually(() => {
      expect(chipOf('W01')).toEqual({ text: 'Filled', tone: 'ok' });
    });
    expect(chipOf('W02')).toEqual({ text: 'Filled', tone: 'ok' });
    expect(chipOf('W03')).toEqual({ text: 'Bought', tone: 'ok' });
    // the rows that say Filled are the rows of the Filled tab
    await user.click(
      within(screen.getByRole('group', { name: 'Wallet filters' })).getByRole('button', {
        name: /^Filled \d+$/u,
      }),
    );
    expect(screen.queryByRole('progressbar', { name: 'Fill of W01' })).not.toBeNull();
    expect(screen.queryByRole('progressbar', { name: 'Fill of W02' })).not.toBeNull();
    expect(screen.queryByRole('progressbar', { name: 'Fill of W03' })).toBeNull();
  });

  it('a DRY-RUN skip says Simulated in the sim tone', async () => {
    const { vault, user } = setup({ dryRun: true });
    await showMint(user);
    act(() => {
      vault.emit(runEvent('started', true));
      vault.emit(
        walletEvent(0, 'SKIPPED', { reason: { kind: 'SKIPPED', code: 'DRY_RUN', detail: null } }),
      );
    });
    await eventually(() => {
      expect(chipOf('W01')).toEqual({ text: 'Simulated', tone: 'sim' });
    });
  });

  it('Scheduled has a clock instead of the running dot; its text stays', async () => {
    const { vault, user } = setup({ dryRun: false });
    await showMint(user);
    act(() => {
      vault.emit(runEvent('started', false));
      vault.emit(walletEvent(0, 'QUEUED'));
      vault.emit(walletEvent(1, 'SCHEDULED', { scheduledAt: 0 }));
    });
    await eventually(() => {
      expect(chipOf('W02').text).toBe('Scheduled');
    });
    expect(chipEl('W02').querySelector('svg.k-i')?.getAttribute('aria-hidden')).toBe('true');
    expect(chipEl('W02').querySelector('.k-dot')).toBeNull();
    // a running wallet keeps its dot and has no icon
    expect(chipEl('W01').querySelector('.k-dot')).not.toBeNull();
    expect(chipEl('W01').querySelector('svg')).toBeNull();
  });
});

/** The text of a wallet's cell in the column with this header. */
function cellOf(label: string, header: string): string {
  const th = screen.getByRole('columnheader', { name: header });
  const column = [...(th.parentElement?.children ?? [])].indexOf(th);
  const bar = screen.getByRole('progressbar', { name: `Fill of ${label}` });
  const cell = bar.closest('tr')?.children[column];
  if (!cell) throw new Error(`no ${header} cell in ${label}`);
  return cell.textContent.trim();
}

/** Wallet names in the order the table shows them. */
function rowOrder(): string[] {
  return screen
    .getAllByRole('progressbar', { name: /^Fill of /u })
    .map((bar) => bar.getAttribute('aria-label')?.replace('Fill of ', '') ?? '?');
}

describe('Tokens estimate and Fill sorting (BUNNDLY-92)', () => {
  // 0.01 SOL quoted for 1 234.5 tokens (6 decimals): 1_234_500_000 base units
  const quote = { inAmount: 10_000_000n, outAmount: 1_234_500_000n, router: 'test' };

  it('DRY-RUN: Tokens says the quote with ≈, the chain balance (0) is not shown as bought', async () => {
    const { vault, user } = setup({ dryRun: true });
    await showMint(user);
    expect(cellOf('W01', 'Tokens (SPL)')).toBe('0');
    act(() => {
      vault.emit(runEvent('started', true));
      vault.emit(
        walletEvent(0, 'SKIPPED', {
          quote,
          reason: { kind: 'SKIPPED', code: 'DRY_RUN', detail: null },
        }),
      );
      vault.emit(walletEvent(1, 'QUEUED', { attempt: 0 }));
    });
    await eventually(() => {
      expect(cellOf('W01', 'Tokens (SPL)')).toBe('≈ 1234.5');
    });
    // no quote yet: the chain balance, without ≈
    expect(cellOf('W02', 'Tokens (SPL)')).toBe('0');
  });

  it('live: Tokens stays the chain balance even with a quote', async () => {
    const { vault, user } = setup({ dryRun: false });
    await showMint(user);
    act(() => {
      vault.emit(runEvent('started', false));
      vault.emit(walletEvent(0, 'SIGNING', { quote }));
    });
    await eventually(() => {
      expect(fillOf('W01')).toEqual({ now: '35', text: '35%, Signing' });
    });
    expect(cellOf('W01', 'Tokens (SPL)')).toBe('0');
  });

  it('Fill sorts the fullest first, then the other way; a click on the header', async () => {
    const { vault, user } = setup({ dryRun: false });
    await showMint(user);
    act(() => {
      vault.emit(runEvent('started', false));
      vault.emit(walletEvent(0, 'QUOTING')); // 20
      vault.emit(walletEvent(1, 'SUBMITTED')); // 60
      vault.emit(walletEvent(2, 'QUEUED', { attempt: 0 })); // 5
    });
    await eventually(() => {
      expect(fillOf('W02').now).toBe('60');
    });
    expect(rowOrder()).toEqual(['W01', 'W02', 'W03']);
    const header = screen.getByRole('columnheader', { name: 'Fill' });
    await user.click(within(header).getByRole('button', { name: 'Fill' }));
    expect(rowOrder()).toEqual(['W02', 'W01', 'W03']);
    expect(header.getAttribute('aria-sort')).toBe('descending');
    await user.click(within(header).getByRole('button', { name: 'Fill' }));
    expect(rowOrder()).toEqual(['W03', 'W01', 'W02']);
    expect(header.getAttribute('aria-sort')).toBe('ascending');
  });
});

describe('Stairs in the toolbar (BUNNDLY-61 part 2)', () => {
  // BUNNDLY-93: Stairs is the default, every 6 s, 1 wallet per step (Andy's interim decision)
  it('Stairs by default, every 6 s and 1 per step, with the plan; BUY sends the steps', async () => {
    const { requests, user } = setup();
    await showMint(user);
    const bar = within(toolbar());
    expect(bar.getByRole('button', { name: 'Stairs' }).getAttribute('aria-pressed')).toBe('true');
    expect(bar.getByRole('button', { name: 'Immediate' }).getAttribute('aria-pressed')).toBe(
      'false',
    );
    expect(bar.getByLabelText<HTMLInputElement>('Seconds between steps').value).toBe('6');
    expect(bar.getByLabelText<HTMLInputElement>('Wallets per step').value).toBe('1');
    // 3 selected, every 6 s, 1 per step: 3 steps, the last one 2 × 6 s = 12 s after the first
    expect(screen.getByTestId('stairs-plan').textContent).toBe('→ 3 steps, last one at +12.0 s');
    await user.clear(bar.getByLabelText('Wallets per step'));
    await user.type(bar.getByLabelText('Wallets per step'), '2');
    // ceil(3 / 2) = 2 steps, the last one 6 s after the first
    expect(screen.getByTestId('stairs-plan').textContent).toBe('→ 2 steps, last one at +6.0 s');
    await user.click(bar.getByRole('button', { name: 'Buy' }));
    expect(requests.filter((r) => r.type === 'startBuy')).toEqual([
      {
        type: 'startBuy',
        mint: MINT,
        wallets: [0, 1, 2],
        group: 'g1',
        stairs: { intervalMs: 6_000, perStep: 2 },
      },
    ]);
  });

  it('Immediate: no step fields, startBuy without stairs', async () => {
    const { requests, user } = setup();
    await showMint(user);
    const bar = within(toolbar());
    await user.click(bar.getByRole('button', { name: 'Immediate' }));
    expect(bar.queryByLabelText('Seconds between steps')).toBeNull();
    await user.click(bar.getByRole('button', { name: 'Buy' }));
    const [start] = requests.filter((r) => r.type === 'startBuy');
    expect(start).toEqual({ type: 'startBuy', mint: MINT, wallets: [0, 1, 2], group: 'g1' });
  });

  // BUNNDLY-93: a run keeps its mode; the switch says why and opens again at the end
  it('while the group runs, Immediate / Stairs is off with the reason; it opens at the end', async () => {
    const { vault, user } = setup();
    await showMint(user);
    const bar = within(toolbar());
    const group = bar.getByRole('group', { name: 'Execution mode' });
    const buttons = () => within(group).getAllByRole('button');
    expect(buttons().map((b) => b.hasAttribute('disabled'))).toEqual([false, false]);
    expect(group.getAttribute('title')).toBeNull();
    act(() => {
      vault.emit(runEvent('started', true));
    });
    await eventually(() => {
      expect(buttons().map((b) => b.hasAttribute('disabled'))).toEqual([true, true]);
    });
    expect(group.getAttribute('title')).toBe('The mode can change once the current run ends.');
    await user.click(bar.getByRole('button', { name: 'Immediate' }));
    expect(bar.getByRole('button', { name: 'Stairs' }).getAttribute('aria-pressed')).toBe('true');
    act(() => {
      vault.emit(runEvent('finished', true));
    });
    await eventually(() => {
      expect(buttons().map((b) => b.hasAttribute('disabled'))).toEqual([false, false]);
    });
    expect(group.getAttribute('title')).toBeNull();
    await user.click(bar.getByRole('button', { name: 'Immediate' }));
    expect(bar.getByRole('button', { name: 'Immediate' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('a step out of 1 s – 24 h stops BUY, SELL and ARM with the reason', async () => {
    const { requests, user } = setup();
    await showMint(user);
    const bar = within(toolbar());
    await user.click(bar.getByRole('button', { name: 'Stairs' }));
    await user.clear(bar.getByLabelText('Seconds between steps'));
    await user.type(bar.getByLabelText('Seconds between steps'), '0');
    const buy = bar.getByRole('button', { name: 'Buy' });
    expect(buy).toHaveProperty('disabled', true);
    expect(buy.getAttribute('aria-description')).toBe(
      'Stairs: the step must be 1 to 86400 seconds.',
    );
    expect(bar.getByRole('button', { name: 'Sell' })).toHaveProperty('disabled', true);
    expect(bar.getByLabelText('Seconds between steps').getAttribute('aria-invalid')).toBe('true');
    await user.click(buy);
    expect(requests.filter((r) => r.type === 'startBuy')).toEqual([]);
  });

  it('a scheduled wallet counts down; Pause and Resume name the group', async () => {
    const { vault, requests, user } = setup();
    await showMint(user);
    const bar = within(toolbar());
    await user.click(bar.getByRole('button', { name: 'Stairs' }));
    await user.click(bar.getByRole('button', { name: 'Buy' }));
    await eventually(() => requests.find((r) => r.type === 'status' || r.type === 'activity'));
    const T = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(T);
    act(() => {
      vault.emit(runEvent('started', true, { intervalMs: 6_000, perStep: 1, paused: false }));
      vault.emit(walletEvent(0, 'QUEUED'));
      vault.emit(walletEvent(1, 'SCHEDULED', { scheduledAt: T + 6_000 }));
      vault.emit(walletEvent(2, 'SCHEDULED', { scheduledAt: T + 72_000 }));
    });
    // 6 s and 72 s ahead: "00:06" and "01:12"
    await eventually(() => {
      expect(fillOf('W02')).toEqual({ now: '0', text: '0%, Starts in 00:06' });
    });
    expect(fillOf('W03')).toEqual({ now: '0', text: '0%, Starts in 01:12' });
    const pause = await eventually(() => bar.getByRole('button', { name: 'Pause' }));
    await user.click(pause);
    expect(requests.filter((r) => r.type === 'pauseStairs')).toEqual([
      { type: 'pauseStairs', group: 'g1' },
    ]);
    await eventually(() => {
      expect(said()).toBe('Paused · wallets already sending will finish');
    });
    act(() => {
      vault.emit(runEvent('paused', true, { intervalMs: 6_000, perStep: 1, paused: true }));
    });
    await eventually(() => {
      expect(fillOf('W02')).toEqual({ now: '0', text: '0%, Paused' });
    });
    await user.click(await eventually(() => bar.getByRole('button', { name: 'Resume' })));
    expect(requests.filter((r) => r.type === 'resumeStairs')).toEqual([
      { type: 'resumeStairs', group: 'g1' },
    ]);
    await eventually(() => {
      expect(said()).toBe('Resumed');
    });
  });
});

describe('the rail says what a command did (BUNNDLY-90)', () => {
  it('BUY: the wallets and the mode the worker accepted, DRY-RUN said', async () => {
    const { user } = setup();
    await showMint(user);
    expect(said()).toBe('');
    await user.click(within(toolbar()).getByRole('button', { name: 'Immediate' }));
    await user.click(within(toolbar()).getByRole('button', { name: 'Buy' }));
    // the fake worker accepts 3 wallets, DRY-RUN, no steps
    await eventually(() => {
      expect(said()).toBe('Buy started on 3 wallets · Immediate · DRY-RUN');
    });
  });

  it('Stairs BUY says Stairs; STOP counts the wallets that had not sent yet', async () => {
    const { vault, requests, user } = setup();
    await showMint(user);
    const bar = within(toolbar());
    await user.click(bar.getByRole('button', { name: 'Stairs' }));
    await user.click(bar.getByRole('button', { name: 'Buy' }));
    await eventually(() => {
      expect(said()).toBe('Buy started on 3 wallets · Stairs · DRY-RUN');
    });
    await eventually(() => requests.find((r) => r.type === 'status' || r.type === 'activity'));
    act(() => {
      vault.emit(runEvent('started', true, { intervalMs: 6_000, perStep: 1, paused: false }));
      vault.emit(walletEvent(0, 'SUBMITTED'));
      vault.emit(walletEvent(1, 'SCHEDULED', { scheduledAt: 0 }));
      vault.emit(walletEvent(2, 'QUEUED', { attempt: 0 }));
    });
    // the clicked rows show queued at once; W01 at 60 % says the events arrived
    await eventually(() => {
      expect(fillOf('W01').text).toBe('60%, Sent');
    });
    expect(fillOf('W03').text).toBe('5%, Queued');
    await user.click(bar.getByRole('button', { name: 'Stop' }));
    // W02 scheduled and W03 queued did not send; W01 was already sent
    await eventually(() => {
      expect(said()).toBe('Stopped · 2 wallets did not send');
    });
  });

  it('a refused command says nothing in the rail; the error says why', async () => {
    const { vault, user } = setup();
    const accept = vault.request.getMockImplementation();
    vault.request.mockImplementation((req: VaultRequest) =>
      req.type === 'startBuy'
        ? Promise.reject(new Error('refused by the test'))
        : (accept?.(req) ?? Promise.reject(new Error(req.type))),
    );
    await showMint(user);
    await user.click(within(toolbar()).getByRole('button', { name: 'Buy' }));
    await eventually(() => {
      expect(requests(vault).some((r) => r.type === 'startBuy')).toBe(true);
    });
    await act(() => Promise.resolve());
    expect(said()).toBe('');
  });

  it('the message goes after 4.2 s: one timer of 4200 ms, and its end clears the line', async () => {
    const { user } = setup();
    await showMint(user);
    const timers = vi.spyOn(window, 'setTimeout');
    await user.click(within(toolbar()).getByRole('button', { name: 'Buy' }));
    await eventually(() => {
      expect(said()).toBe('Buy started on 3 wallets · Stairs · DRY-RUN');
    });
    // the passive effect that sets the timer runs after the commit that shows the text
    await act(() => Promise.resolve());
    const sayTimers = timers.mock.calls.filter(([, ms]) => ms === 4_200);
    expect(sayTimers).toHaveLength(1);
    const [end] = sayTimers[0] ?? [];
    timers.mockRestore();
    act(() => {
      if (typeof end === 'function') end();
    });
    expect(said()).toBe('');
  });
});
