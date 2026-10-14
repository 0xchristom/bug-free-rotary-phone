// @vitest-environment jsdom
/**
 * Mode B in the UI (BUNNDLY-35, D-039; command bar BUNNDLY-59): creator address, arming
 * conditions, ARM / DISARM, live mode only after a confirmation, connection states, the alarm (mock
 * AudioContext), Wake Lock (mock navigator.wakeLock), detections and the progress from
 * a detection. Events and status from a mock worker.
 */
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FleetSettingsV1 } from '../../src/core/index.ts';
import type { RunEvent } from '../../src/executor/index.ts';
import { App } from '../../src/ui/App.tsx';
import {
  ALARM_REPEAT_MS,
  type AudioContextLike,
  type WakeLockLike,
  type WakeLockSentinelLike,
  type WatchBrowser,
} from '../../src/ui/watch-runtime.ts';
import type { WatchDetection, WatchStatus } from '../../src/watcher/watch.ts';
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
import { setupUser } from './user.ts';

afterEach(cleanup);

const CREATOR = 'FQ6WmS5szfK1NRVcGkAqeVbwNeL9kt4xJXhwviyWTB7K';
const FLEET_ADDRESS = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const MINT = 'HEhuwZjGd8Za7jgjzzpsXJssnP89DQm4oYHghRpnpump';
const SIG = `${'3'.repeat(40)}${'A'.repeat(48)}`;

/** Mock Web Audio: counts the tones. */
function mockAudio() {
  const tones: number[] = [];
  let created = 0;
  const create = (): AudioContextLike => {
    created += 1;
    return {
      currentTime: 0,
      destination: {},
      createGain: () => ({ gain: { value: 1 }, connect: () => undefined }),
      createOscillator: () => ({
        type: 'sine',
        frequency: { value: 0 },
        connect: () => undefined,
        start: () => {
          tones.push(Date.now());
        },
        stop: () => undefined,
      }),
      resume: () => Promise.resolve(),
    };
  };
  return { create, tones, created: () => created };
}

/** Mock `navigator.wakeLock`: each request gives a sentinel the test can release. */
function mockWakeLock(refuse = false) {
  const sentinels: (WakeLockSentinelLike & { drop: () => void })[] = [];
  /** Index of each sentinel the app released. */
  const releases = vi.fn<(n: number) => void>();
  const request = vi.fn((): Promise<WakeLockSentinelLike> => {
    if (refuse) return Promise.reject(new DOMException('no', 'NotAllowedError'));
    const listeners: (() => void)[] = [];
    const n = sentinels.length;
    const s = {
      released: false,
      release: () => {
        s.released = true;
        releases(n);
        return Promise.resolve();
      },
      addEventListener: (_t: 'release', l: () => void) => {
        listeners.push(l);
      },
      /** The browser lets go (tab hidden). */
      drop: () => {
        s.released = true;
        for (const l of listeners) l();
      },
    };
    sentinels.push(s);
    return Promise.resolve(s);
  });
  const api: WakeLockLike = { request };
  return { api, request, sentinels, releases };
}

interface Setup {
  readonly global?: Partial<FleetSettingsV1['global']>;
  readonly helius?: boolean;
  readonly maxSpend?: boolean;
  readonly browser?: Partial<WatchBrowser>;
  readonly alarmRepeatMs?: number;
}

function detection(extra: Partial<WatchDetection> = {}): WatchDetection {
  return {
    mint: MINT,
    source: 'pump.fun',
    path: 'log',
    signature: SIG,
    detectedAt: Date.UTC(2026, 9, 3, 12, 0, 5),
    runId: 1,
    reactionMs: 4.2,
    verified: true,
    problem: null,
    ...extra,
  };
}

function setup(o: Setup = {}) {
  const base = fleetInfo(3);
  let info: VaultInfo = {
    ...base,
    wallets: base.wallets.map((w, i) => (i === 0 ? { ...w, address: FLEET_ADDRESS } : w)),
    settings: {
      ...base.settings,
      maxSpend:
        o.maxSpend === false
          ? []
          : base.wallets.map((w) => ({ index: w.index, lamports: 10_000_000n })),
      global: { ...base.settings.global, ...o.global },
    },
    apiKeys: { ...base.apiKeys, helius: o.helius ?? true },
  };
  let watch: WatchStatus | null = null;
  const status = (): VaultStatus => ({
    locked: false,
    network: 'mainnet',
    armed: watch?.armed ?? false,
    info,
    buy: null,
    watch,
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
          balances: info.wallets.map((w) => ({ index: w.index, lamports: 1_000_000_000n })),
          network: 'mainnet',
          source: 'helius',
          fetchedAt: '2026-10-03T12:00:00.000Z',
        });
      case 'classifyTarget':
        return classifyFake(req.address, { [MINT]: 'spl-token' });
      case 'arm':
        watch = {
          creator: req.creator,
          armedAt: '2026-10-03T12:00:00.000Z',
          mode: info.settings.global.mode,
          armed: true,
          connection: 'connecting',
          attempt: 0,
          lastMessageAt: null,
          detections: [],
          queued: [],
        };
        return Promise.resolve(status());
      case 'disarm':
        if (watch) watch = { ...watch, armed: false, connection: 'disconnected', queued: [] };
        return Promise.resolve(status());
      case 'saveSettings':
        info = { ...info, settings: { ...info.settings, ...req.settings } };
        return Promise.resolve({ fileText: '{"saved":true}', info });
      default:
        return Promise.reject(new Error(req.type));
    }
  });
  const audio = mockAudio();
  const wake = mockWakeLock();
  const browser: WatchBrowser = {
    createAudioContext: audio.create,
    wakeLock: wake.api,
    ...o.browser,
  };
  const storage = mockStorage();
  render(
    <App
      vault={vault.client}
      storage={storage.env}
      statusPollMs={60_000}
      balanceRefreshMs={60_000}
      watchBrowser={browser}
      {...(o.alarmRepeatMs === undefined ? {} : { alarmRepeatMs: o.alarmRepeatMs })}
    />,
  );
  /** The worker's watcher changes: new status, then an event (the UI re-reads). */
  const update = (change: Partial<WatchStatus>): void => {
    if (watch === null) throw new Error('not armed');
    watch = { ...watch, ...change };
    act(() => {
      vault.emit({
        kind: 'watch',
        at: Date.now(),
        type: 'connection',
        status: watch?.connection ?? 'connecting',
        attempt: watch?.attempt ?? 0,
        lastMessageAt: null,
      });
    });
  };
  // these tests type whole addresses: no 16 ms timer per key (see setupUser)
  return { vault, requests, audio, wake, update, user: setupUser() };
}

/** The fleet screen with its balances read: the command bar is ready. */
async function openTabB(): Promise<void> {
  await screen.findByText(/^Balances as of /u);
}

/** Types a creator into the command bar and waits until the worker named it a wallet. */
async function typeCreator(user: UserEvent, creator = CREATOR): Promise<void> {
  await user.type(screen.getByLabelText(TARGET_LABEL), creator);
  await screen.findByText('Creator wallet', {}, TARGET_WAIT);
}

const armButton = () => screen.getByRole('button', { name: 'ARM' });

async function arm(user: UserEvent): Promise<void> {
  await openTabB();
  await typeCreator(user);
  await user.click(armButton());
  await screen.findByRole('button', { name: 'DISARM' });
}

describe('creator address and arming conditions', () => {
  it('validates the address and warns about a fleet address', async () => {
    const { user } = setup();
    await openTabB();
    const input = screen.getByLabelText(TARGET_LABEL);
    await user.type(input, 'not-an-address');
    expect(screen.getByRole('alert').textContent).toMatch(/Paste a full Solana address/u);
    expect(armButton()).toHaveProperty('disabled', true);
    expect(armButton().getAttribute('aria-description')).toBe('Paste a creator wallet first.');
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
    // a token is not a creator: ARM says so
    await user.clear(input);
    await user.type(input, MINT);
    await screen.findByText('Token · SPL', {}, TARGET_WAIT);
    expect(armButton()).toHaveProperty('disabled', true);
    expect(armButton().getAttribute('aria-description')).toBe(
      'ARM needs a creator wallet, not a token.',
    );
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

describe('ARM / DISARM', () => {
  it('DRY-RUN: ARM sends arm at once, DISARM sends disarm', async () => {
    const { user, requests } = setup();
    await arm(user);
    expect(requests.filter((r) => r.type === 'arm')).toEqual([
      { type: 'arm', creator: CREATOR, wallets: [0, 1, 2], group: 'g1' },
    ]);
    expect(screen.getByText(/The watcher is armed. Do not close/u)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'DISARM' }));
    expect(requests.some((r) => r.type === 'disarm')).toBe(true);
    await screen.findByRole('button', { name: 'ARM' });
  });

  it('live mode: only after the confirmation; "Cancel" sends nothing', async () => {
    const { user, requests } = setup({ global: { dryRun: false } });
    await openTabB();
    await typeCreator(user);
    await user.click(armButton());
    const dialog = screen.getByRole('alertdialog', { name: 'Arm the watcher in live mode?' });
    // 3 wallets × 0.01 SOL saved max spend
    expect(within(dialog).getByText('Wallets').nextElementSibling?.textContent).toBe('3');
    expect(within(dialog).getByText('up to 0.03 SOL')).toBeTruthy();
    expect(within(dialog).getByText(/one buy, then the watcher disarms/u)).toBeTruthy();
    expect(requests.some((r) => r.type === 'arm')).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(requests.some((r) => r.type === 'arm')).toBe(false);
    await user.click(armButton());
    await user.click(screen.getByRole('button', { name: 'Yes, arm' }));
    await screen.findByRole('button', { name: 'DISARM' });
    expect(requests.filter((r) => r.type === 'arm')).toHaveLength(1);
  });

  it('continuous mode needs a confirmation and is saved as a setting', async () => {
    const { user, requests } = setup();
    await openTabB();
    await user.click(screen.getByRole('radio', { name: 'continuous' }));
    expect(screen.getByRole('alertdialog').textContent).toMatch(/Turn on continuous mode/u);
    expect(requests.some((r) => r.type === 'saveSettings')).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Yes, continuous mode' }));
    await waitFor(() => {
      expect(requests.find((r) => r.type === 'saveSettings')).toMatchObject({
        settings: { global: { mode: 'continuous' } },
      });
    });
  });
});

describe('an armed watcher freezes the settings', () => {
  it('no mode switch, no table, wallet or settings save until DISARM', async () => {
    const { user } = setup();
    await arm(user);
    expect(screen.queryByRole('button', { name: 'Switch to live mode…' })).toBeNull();
    expect(
      screen.getAllByText(/Disarm the watcher to change the mode or the settings/u).length,
    ).toBe(
      3, // mode, table, wallets
    );
    expect(screen.getByRole('button', { name: 'Save table changes' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByRole('button', { name: 'Create wallets' })).toHaveProperty('disabled', true);
    await user.click(
      within(screen.getByRole('navigation')).getByRole('button', { name: 'Settings' }),
    );
    expect(await screen.findByRole('button', { name: 'Save settings' })).toHaveProperty(
      'disabled',
      true,
    );
    expect(screen.getByText(/Disarm the watcher to change/u)).toBeTruthy();
    await user.click(within(screen.getByRole('navigation')).getByRole('button', { name: 'Fleet' }));
    await user.click(screen.getByRole('button', { name: 'DISARM' }));
    expect(await screen.findByRole('button', { name: 'Switch to live mode…' })).toBeTruthy();
    expect(screen.queryByText(/Disarm the watcher to change/u)).toBeNull();
  });
});

describe('connection, alarm and Wake Lock', () => {
  it('connection states as text; losing it while armed: banner and tone until it is back', async () => {
    const { user, update, audio } = setup();
    await arm(user);
    expect(audio.created()).toBe(1); // made by the click on ARM
    expect(await screen.findByText('Connecting…')).toBeTruthy();
    update({ connection: 'connected', lastMessageAt: Date.now() });
    expect(await screen.findByText('Connected')).toBeTruthy();
    expect(screen.getByText(/last message \d+ s ago/u)).toBeTruthy();
    expect(audio.tones).toHaveLength(0);

    update({ connection: 'reconnecting', attempt: 2 });
    const banner = await screen.findByText(/The connection to Helius was lost/u);
    expect(banner.closest('[role="alert"]')).toBeTruthy();
    expect(screen.getAllByText(/Reconnecting \(attempt 2\)/u).length).toBeGreaterThan(0);
    await waitFor(() => {
      expect(audio.tones.length).toBeGreaterThanOrEqual(1);
    });

    update({ connection: 'connected' });
    await waitFor(() => {
      expect(screen.queryByText(/The connection to Helius was lost/u)).toBeNull();
    });
    const after = audio.tones.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(audio.tones).toHaveLength(after);
  });

  it('the tone repeats until "Mute"; the banner stays', async () => {
    const { user, update, audio } = setup({ alarmRepeatMs: 20 });
    await arm(user);
    update({ connection: 'disconnected' });
    await screen.findByText(/The connection to Helius was lost/u);
    await waitFor(() => {
      expect(audio.tones.length).toBeGreaterThanOrEqual(3);
    });
    await user.click(screen.getByRole('button', { name: 'Mute' }));
    const muted = audio.tones.length;
    await new Promise((r) => setTimeout(r, 150));
    expect(audio.tones).toHaveLength(muted);
    expect(screen.getByText(/The connection to Helius was lost/u)).toBeTruthy();
  });

  it('the default repeat is every 3 s', () => {
    expect(ALARM_REPEAT_MS).toBe(3_000);
  });

  it('Wake Lock: held while armed, requested again after the tab is visible again, released on disarm', async () => {
    const { user, wake } = setup();
    await arm(user);
    await waitFor(() => {
      expect(wake.request).toHaveBeenCalledTimes(1);
    });
    expect(wake.request).toHaveBeenCalledWith('screen');
    // the browser lets go when the tab is hidden; visible again → a new request
    act(() => {
      wake.sentinels[0]?.drop();
    });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => {
      expect(wake.request).toHaveBeenCalledTimes(2);
    });
    await user.click(screen.getByRole('button', { name: 'DISARM' }));
    await waitFor(() => {
      expect(wake.releases).toHaveBeenCalledWith(1);
    });
  });

  it('no Wake Lock API: a note in the panel, no error', async () => {
    const { user } = setup({ browser: { wakeLock: null } });
    await arm(user);
    expect(await screen.findByText(/The screen may turn off/u)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('Wake Lock refused: the same note', async () => {
    const { user } = setup({ browser: { wakeLock: mockWakeLock(true).api } });
    await arm(user);
    expect(await screen.findByText(/The screen may turn off/u)).toBeTruthy();
  });
});

describe('detections and progress', () => {
  it('the list: time, short mint with copy, source, path, reaction, verified, result', async () => {
    const { user, update } = setup();
    await arm(user);
    update({
      connection: 'connected',
      detections: [
        detection(),
        detection({
          mint: 'Cv3DkGpXCiMeacQSWrshtrZjWkzVKpPUxfYz5RMQpump',
          source: 'raydium-launchlab',
          path: 'transaction',
          runId: null,
          reactionMs: null,
          verified: null,
        }),
        detection({
          mint: '5vxZ1ZhyeqKW33V41E5dFsegrUhdGxGKU5rx4u4Xpump',
          source: 'initialize-mint',
          path: 'catch-up',
          runId: null,
          reactionMs: null,
          verified: null,
          problem: 'STALE',
        }),
      ],
      queued: ['Cv3DkGpXCiMeacQSWrshtrZjWkzVKpPUxfYz5RMQpump'],
    });
    const table = await screen.findByRole('table', { name: 'Detections' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringMatching(/HEhu…pump.*pump\.fun.*log.*4 ms.*verified.*buy #1/u),
      expect.stringMatching(/Cv3D…pump.*LaunchLab.*transaction.*–.*queued/u),
      expect.stringMatching(/5vxZ…pump.*InitializeMint.*catch-up.*from before arming/u),
    ]);
    expect(within(table).getByRole('button', { name: `Copy mint ${MINT}` })).toBeTruthy();
  });

  it('the bar shows the newest usable detection; BUY can buy it (BUNNDLY-59)', async () => {
    const { user, update } = setup();
    await arm(user);
    const buy = screen.getByRole('button', { name: 'BUY' });
    expect(buy).toHaveProperty('disabled', true);
    expect(screen.queryByLabelText(/^Detected token/u)).toBeNull();
    const usable = 'Cv3DkGpXCiMeacQSWrshtrZjWkzVKpPUxfYz5RMQpump';
    update({
      connection: 'connected',
      detections: [
        detection(),
        detection({ mint: usable, source: 'raydium-launchlab', runId: null }),
        // newest, but from before arming: not a token to buy
        detection({
          mint: '5vxZ1ZhyeqKW33V41E5dFsegrUhdGxGKU5rx4u4Xpump',
          runId: null,
          problem: 'STALE',
        }),
      ],
    });
    const chip = await screen.findByLabelText(`Detected token ${usable}`);
    expect(chip.textContent).toBe('Detected Cv3D…pump · LaunchLab');
    expect(screen.getByRole('button', { name: 'BUY' })).toHaveProperty('disabled', false);
    // the armed watcher may buy this token at any moment: no sell meanwhile
    const sell = screen.getByRole('button', { name: 'SELL' });
    expect(sell).toHaveProperty('disabled', true);
    expect(sell.getAttribute('aria-description')).toBe(
      'DISARM first: the armed watcher may buy this token at any moment.',
    );
  });

  it('a buy started by a detection: the shared progress view counts from the detection', async () => {
    const { user, update, vault } = setup();
    await arm(user);
    update({ connection: 'connected', detections: [detection()] });
    await screen.findByRole('table', { name: 'Detections' });
    const started: RunEvent = {
      kind: 'run',
      runId: 1,
      at: 0,
      phase: 'started',
      mint: MINT,
      dryRun: true,
      wallets: 3,
      counts: {
        IDLE: 3,
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
    };
    act(() => {
      vault.emit(started);
    });
    expect(await screen.findByText(/0\/3 confirmed/u)).toBeTruthy();
    expect(screen.getByText(/From detection to the first confirmation/u)).toBeTruthy();
  });
});
