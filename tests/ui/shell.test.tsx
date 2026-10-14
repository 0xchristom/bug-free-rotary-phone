// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { setupUser } from './user.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../src/core/errors.ts';
import type { Network } from '../../src/core/network.ts';
import type { AutoLockMinutes } from '../../src/core/settings.ts';
import { App } from '../../src/ui/App.tsx';
import { StatusBar } from '../../src/ui/StatusBar.tsx';
import type { WatchStatus } from '../../src/watcher/watch.ts';
import type { VaultBalances, VaultStatus } from '../../src/worker/protocol.ts';
import { LOCKED, TARGET_LABEL, fleetInfo, mockStorage, mockVault, unlocked } from './fakes.ts';

const STATUS_POLL_MS = 5_000;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function rail(): HTMLElement {
  return screen.getByLabelText('Status');
}

async function tick(ms: number): Promise<void> {
  await act(() => vi.advanceTimersByTimeAsync(ms));
}

/** A vault whose balance reads take `delayMs` and come from `source`; both can be changed. */
function slowVault(source: VaultBalances['source'], delayMs: number) {
  const vault = mockVault(unlocked());
  const plain = vault.request.getMockImplementation();
  if (!plain) throw new Error('mockVault has no implementation');
  const answer = { source, delayMs, network: 'mainnet' as Network };
  vault.request.mockImplementation((req, options) =>
    req.type === 'refreshBalances'
      ? new Promise((resolve) => {
          const { source: from, network } = answer;
          setTimeout(() => {
            resolve({ network, balances: [], source: from, fetchedAt: '2026-10-12T12:00:00.000Z' });
          }, answer.delayMs);
        })
      : plain(req, options),
  );
  return { vault, answer };
}

async function renderShell(vault: ReturnType<typeof mockVault>): Promise<void> {
  // The read time is measured with performance.now(), so that clock is faked too.
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
  });
  render(
    <App
      vault={vault.client}
      storage={mockStorage().env}
      statusPollMs={STATUS_POLL_MS}
      balanceRefreshMs={60_000}
    />,
  );
  // The vault status answers, the fleet screen mounts and asks for the balances.
  await tick(0);
}

describe('status rail: where the last read came from', () => {
  it('says "no read yet" until a read answers, then Helius with the measured time', async () => {
    const { vault } = slowVault('helius', 37);
    await renderShell(vault);
    expect(rail().textContent).toContain('RPC: no read yet');
    await tick(36);
    expect(rail().textContent).toContain('RPC: no read yet');
    await tick(1);
    expect(rail().textContent).toContain('Helius RPC 37 ms');
    expect(rail().textContent).not.toContain('Fallback');
    expect(rail().textContent).not.toContain('no read yet');
  });

  it('a read answered by the public RPC is called a fallback, never Helius', async () => {
    const { vault } = slowVault('fallback', 120);
    await renderShell(vault);
    await tick(120);
    const item = within(rail()).getByText(/Fallback RPC \(public\)/u);
    expect(item.textContent).toBe('Fallback RPC (public) 120 ms');
    expect(item.getAttribute('data-tone')).toBe('warn');
    expect(rail().textContent).not.toContain('Helius');
  });

  it('follows the source read by read: Helius, then the fallback, then Helius again', async () => {
    const { vault, answer } = slowVault('helius', 10);
    await renderShell(vault);
    await tick(10);
    expect(rail().textContent).toContain('Helius RPC 10 ms');

    answer.source = 'fallback';
    answer.delayMs = 250;
    await tick(60_000 + 250);
    expect(rail().textContent).toContain('Fallback RPC (public) 250 ms');
    expect(rail().textContent).not.toContain('Helius');

    answer.source = 'helius';
    answer.delayMs = 5;
    await tick(60_000 + 5);
    expect(rail().textContent).toContain('Helius RPC 5 ms');
    expect(rail().textContent).not.toContain('Fallback');
  });

  it('does not show a mainnet read on devnet: the rail waits for a devnet read', async () => {
    const { vault, answer } = slowVault('helius', 20);
    await renderShell(vault);
    await tick(20);
    expect(rail().textContent).toContain('Helius RPC 20 ms');

    // The network changes (seen by the status poll); the devnet read is slow.
    answer.network = 'devnet';
    answer.source = 'fallback';
    answer.delayMs = 900;
    const info = fleetInfo();
    const { settings } = info;
    vault.setStatus({
      ...unlocked(),
      network: 'devnet',
      info: {
        ...info,
        settings: { ...settings, global: { ...settings.global, network: 'devnet' } },
      },
    });
    await tick(STATUS_POLL_MS);
    expect(within(rail()).getByText('Devnet')).toBeTruthy();
    expect(rail().textContent).toContain('RPC: no read yet');
    expect(rail().textContent).not.toContain('Helius');
    await tick(900);
    expect(rail().textContent).toContain('Fallback RPC (public) 900 ms');
  });

  it('forgets the read when the fleet is locked: the next fleet starts from "no read yet"', async () => {
    const { vault, answer } = slowVault('helius', 15);
    await renderShell(vault);
    await tick(15);
    expect(rail().textContent).toContain('Helius RPC 15 ms');

    vault.setStatus(LOCKED);
    await tick(STATUS_POLL_MS);
    expect(rail().textContent).toBe('v0.0.0Mainnet');

    answer.delayMs = 2_000;
    vault.setStatus(unlocked());
    await tick(STATUS_POLL_MS);
    expect(rail().textContent).toContain('RPC: no read yet');
    expect(rail().textContent).not.toContain('Helius');
  });
});

describe('status rail: the rest of the line', () => {
  function watching(connection: WatchStatus['connection'], attempt = 0): VaultStatus {
    return {
      ...unlocked(true),
      watch: {
        creator: 'Creator1111111111111111111111111111111111111',
        armedAt: '2026-10-12T10:00:00.000Z',
        mode: 'one-shot',
        armed: true,
        connection,
        attempt,
        lastMessageAt: null,
        detections: [],
        queued: [],
      },
    };
  }

  function show(status: VaultStatus | null, autoLockMinutes: AutoLockMinutes | null = 15) {
    render(
      <StatusBar version="1.2.3" status={status} read={null} autoLockMinutes={autoLockMinutes} />,
    );
    return rail();
  }

  it('before the vault answers it shows the version only', () => {
    expect(show(null).textContent).toBe('v1.2.3');
  });

  it('a locked vault shows the version and the network, nothing about a fleet', () => {
    expect(show(LOCKED).textContent).toBe('v1.2.3Mainnet');
  });

  it.each([
    [15, 'Auto-lock after 15 min of inactivity'],
    [60, 'Auto-lock after 1 h of inactivity'],
    [120, 'Auto-lock after 2 h of inactivity'],
    [null, 'Auto-lock: off'],
  ] as const)('an open fleet with auto-lock %s says "%s" and no socket', (minutes, label) => {
    const text = show(unlocked(), minutes).textContent;
    expect(text).toContain(label);
    expect(text).toContain('Backup: manual');
    expect(text).toContain('WebSocket: off');
  });

  it('an armed fleet says the auto-lock is paused, not when it would lock', () => {
    const text = show(watching('connected')).textContent;
    expect(text).toContain('Armed: auto-lock is paused');
    expect(text).not.toContain('Auto-lock after');
  });

  it('an armed fleet with auto-lock off says it is off, not paused', () => {
    const text = show(watching('connected'), null).textContent;
    expect(text).toContain('Auto-lock: off');
    expect(text).not.toContain('paused');
  });

  it.each([
    ['connected', 0, 'WebSocket: Connected', 'ok'],
    ['connecting', 0, 'WebSocket: Connecting…', 'warn'],
    ['reconnecting', 3, 'WebSocket: Reconnecting (attempt 3)', 'danger'],
  ] as const)('socket %s is shown as "%s%s" in tone %s', (connection, attempt, label, tone) => {
    const item = within(show(watching(connection, attempt))).getByText(label);
    expect(item.getAttribute('data-tone')).toBe(tone);
  });

  it('a watcher that is no longer armed does not claim a live socket', () => {
    const status = watching('connected');
    const disarmed: VaultStatus = {
      ...status,
      armed: false,
      watch: status.watch && { ...status.watch, armed: false },
    };
    expect(show(disarmed).textContent).toContain('WebSocket: off');
  });
});

describe('keyboard', () => {
  /** What Tab must reach: every enabled control; of a radio group only its entry point. */
  function tabStops(): Element[] {
    const all = [...document.querySelectorAll('button, input, select, textarea, a[href]')];
    return all.filter((el) => {
      if (el.matches(':disabled')) return false;
      if (el instanceof HTMLInputElement && el.type === 'radio') {
        const group = all.filter(
          (other) =>
            other instanceof HTMLInputElement && other.type === 'radio' && other.name === el.name,
        );
        const entry = group.find((other) => (other as HTMLInputElement).checked) ?? group[0];
        return entry === el;
      }
      return true;
    });
  }

  it('Tab walks the fleet screen in document order and reaches every button and field', async () => {
    const user = setupUser();
    render(<App vault={mockVault(unlocked()).client} storage={mockStorage().env} />);
    await screen.findByRole('heading', { name: 'Fleet' });
    await screen.findByText('1.5');

    const expected = tabStops();
    // The shell (nav, lock), the token field, the buy panel, the table rows, the backup.
    expect(expected.length).toBeGreaterThan(25);
    expect(expected).toContain(screen.getByRole('button', { name: 'Lock' }));
    expect(expected).toContain(screen.getByRole('button', { name: /^Fleet balance:/u }));
    expect(expected).toContain(screen.getByLabelText(TARGET_LABEL));

    const visited: Element[] = [];
    for (let i = 0; i < expected.length; i++) {
      await user.tab();
      if (document.activeElement) visited.push(document.activeElement);
    }
    expect(visited.map(describeStop)).toEqual(expected.map(describeStop));
    expect(visited).toEqual(expected);
    // No positive tabindex anywhere: the order is the order on screen.
    expect(
      document.querySelectorAll('[tabindex]:not([tabindex="0"]):not([tabindex="-1"])'),
    ).toHaveLength(0);
    // One more Tab leaves the page and comes back to the first stop.
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(expected[0]);
  });

  function describeStop(el: Element): string {
    const name = el.getAttribute('aria-label') ?? el.textContent;
    return `${el.tagName.toLowerCase()}:${name.trim().slice(0, 40)}`;
  }

  it('the focus ring is drawn from a token and no control switches it off', () => {
    const base = readFileSync('src/ui/base.css', 'utf8');
    expect(base).toMatch(/:focus-visible\s*\{\s*outline:\s*2px solid var\(--focus\);/u);
    const kit = readFileSync('src/ui/kit/kit.css', 'utf8');
    // `outline: none` is allowed only where another element draws the ring: the inner field
    // of NumberInput (its box does) and the dialog and popover containers themselves.
    const off = [
      ...`${base}\n${kit}`.matchAll(/([^{}]+)\{[^}]*outline:\s*(?:none|0)\b[^}]*\}/gu),
    ].map((m) => (m[1] ?? '').trim());
    // The target field of the dashboard: its box draws the ring around the input.
    expect(off).toEqual(['.target .field input', '.k-num-input', '.k-pop:focus', '.k-modal:focus']);
    expect(base).toMatch(
      /\.target \.field:focus-within\s*\{\s*outline:\s*2px solid var\(--focus\);/u,
    );
    expect(kit).toMatch(/\.k-num:focus-within\s*\{\s*outline:\s*2px solid var\(--focus\);/u);
  });

  it('the live-mode confirmation: focus moves in, Tab stays in, Esc closes and gives focus back', async () => {
    const user = setupUser();
    render(<App vault={mockVault(unlocked()).client} storage={mockStorage().env} />);
    const opener = await screen.findByRole('switch', { name: 'DRY-RUN' });
    opener.focus();
    await user.keyboard('{Enter}');

    const dialog = screen.getByRole('alertdialog', { name: 'Switch to live mode?' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    // The safe choice comes first and gets the focus.
    expect(document.activeElement).toBe(cancel);
    const buttons = within(dialog).getAllByRole('button');
    expect(buttons).toHaveLength(2);
    await user.tab();
    expect(document.activeElement).toBe(buttons[1]);
    await user.tab();
    expect(document.activeElement).toBe(cancel);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(buttons[1]);

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
    // Esc cancelled: nothing was saved, the fleet is still in DRY-RUN.
    expect(opener.getAttribute('aria-checked')).toBe('true');
  });

  async function fleetWithUser(vault = mockVault(unlocked())) {
    const user = setupUser();
    render(<App vault={vault.client} storage={mockStorage().env} />);
    await screen.findByText('1.5');
    return user;
  }

  const EXPORT_OPENER = 'Plain export (recovery phrase and keys)';
  const PASSWORD_LABEL = 'Fleet password (type it again)';

  it('the plain export dialog: Escape closes it like Cancel, the focus goes back, the password is gone', async () => {
    const user = await fleetWithUser();
    const opener = screen.getByRole('button', { name: EXPORT_OPENER });
    opener.focus();
    await user.keyboard('{Enter}');
    const dialog = screen.getByRole('dialog');
    // Focus is inside the dialog, so the key reaches it without a click.
    expect(document.activeElement).toBe(dialog);
    await user.type(within(dialog).getByLabelText(PASSWORD_LABEL), 'not-the-password');
    expect(within(dialog).getByLabelText<HTMLInputElement>(PASSWORD_LABEL).value).toBe(
      'not-the-password',
    );

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);

    await user.keyboard('{Enter}');
    expect(
      within(screen.getByRole('dialog')).getByLabelText<HTMLInputElement>(PASSWORD_LABEL).value,
    ).toBe('');
  });

  it('the plain export dialog: Escape does not close it while the password is checked', async () => {
    const vault = mockVault(unlocked());
    const plain = vault.request.getMockImplementation();
    if (!plain) throw new Error('mockVault has no implementation');
    let refuse: (reason: Error) => void = () => undefined;
    vault.request.mockImplementation((req, options) =>
      req.type === 'exportPlain'
        ? new Promise((_resolve, reject) => {
            refuse = reject;
          })
        : plain(req, options),
    );
    const user = await fleetWithUser(vault);
    await user.click(screen.getByRole('button', { name: EXPORT_OPENER }));
    const dialog = screen.getByRole('dialog');
    await user.click(
      within(dialog).getByLabelText('I understand that this file gives full access to the funds'),
    );
    await user.type(within(dialog).getByLabelText(PASSWORD_LABEL), 'not-the-password');
    await user.click(within(dialog).getByRole('button', { name: 'Download the plain export' }));
    expect(within(dialog).getByText('Checking the password…')).toBeTruthy();
    // Cancel is off in this state, and Escape is Cancel.
    expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Cancel' }).disabled).toBe(
      true,
    );
    dialog.focus();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(vault.calls('exportPlain')).toBe(1);

    await act(async () => {
      refuse(new AppError('KEYSTORE_WRONG_PASSWORD_OR_CORRUPTED'));
      await Promise.resolve();
    });
    expect((await within(dialog).findByRole('alert')).textContent).toContain(
      'The password is wrong',
    );
    dialog.focus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('the QR code: focus moves into its popover, Escape closes it and focuses its button', async () => {
    const user = await fleetWithUser();
    const opener = screen.getByRole('button', { name: 'QR code W01' });
    opener.focus();
    await user.keyboard('{Enter}');
    const popover = screen.getByRole('dialog', { name: 'QR code of W01' });
    expect(
      within(popover).getByRole('img', { name: 'QR code of the address Address0' }),
    ).toBeTruthy();
    expect(opener.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(popover);

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('img', { name: /QR code of the address/u })).toBeNull();
    expect(opener.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(opener);
  });

  it('a press outside closes the QR code; Escape then closes only the dialog with the focus', async () => {
    const user = await fleetWithUser();
    await user.click(screen.getByRole('button', { name: 'QR code W02' }));
    expect(screen.getByRole('img', { name: 'QR code of the address Address1' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: EXPORT_OPENER }));
    expect(screen.queryByRole('img', { name: /QR code of the address/u })).toBeNull();
    expect(screen.getAllByRole('dialog')).toHaveLength(1);

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: EXPORT_OPENER }));
  });
});

describe('top bar: the mode switch and the mode chip', () => {
  // The mode sentences, typed here by hand. DRY-RUN does sign (SPEC 7): it only never sends.
  // The Dashboard has the switch (mockup v2); the other screens keep the plain chip.
  const DRY_RUN = 'DRY-RUN: real price requests and signatures, but no transaction will be sent.';
  const LIVE = 'Live mode: a buy sends real transactions and spends SOL from the wallets.';

  async function chipOf(dryRun: boolean): Promise<HTMLElement> {
    const base = unlocked();
    if (!base.info) throw new Error('fixture');
    const { settings } = base.info;
    const info = {
      ...base.info,
      settings: { ...settings, global: { ...settings.global, dryRun } },
    };
    const user = setupUser();
    render(<App vault={mockVault({ ...base, info }).client} storage={mockStorage().env} />);
    await screen.findByRole('heading', { name: 'Fleet' });
    const toggle = screen.getByRole('switch', { name: 'DRY-RUN' });
    expect(toggle.getAttribute('aria-checked')).toBe(String(dryRun));
    // The plain chip is not on the Dashboard: the switch says the mode there.
    expect(screen.queryByText(/^Mode: /u)).toBeNull();
    expect(toggle.getAttribute('title')).toBe(dryRun ? DRY_RUN : LIVE);
    await user.click(
      within(screen.getByRole('navigation')).getByRole('button', { name: 'Settings' }),
    );
    await screen.findByRole('heading', { name: 'Settings' });
    return screen.getByText(dryRun ? 'Mode: DRY-RUN' : 'Mode: LIVE');
  }

  it('in DRY-RUN the switch and the chip say the same: signed, never sent', async () => {
    const chip = await chipOf(true);
    expect(chip.getAttribute('title')).toBe(DRY_RUN);
    expect(chip.getAttribute('title')).not.toMatch(/signs nothing/iu);
  });

  it('in live mode the switch and the chip say the same: real transactions, real SOL', async () => {
    const chip = await chipOf(false);
    expect(chip.getAttribute('title')).toBe(LIVE);
  });
});
