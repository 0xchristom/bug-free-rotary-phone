// @vitest-environment jsdom
/** The Fill column, the fleet fill and the state chips Sold, Stopped and Retrying (BUNNDLY-56, BUNNDLY-89). Setup: FillStairs.fixture.tsx. */
import { readFileSync } from 'node:fs';
import { act, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { eventually } from './settle.ts';
import {
  setup,
  runEvent,
  walletEvent,
  verifyEvent,
  showMint,
  fillOf,
  segmentTones,
  chipOf,
} from './FillStairs.fixture.tsx';

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
