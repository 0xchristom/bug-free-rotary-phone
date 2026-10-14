/** Shared setup of the WatchCommands tests, split into several files (BUNNDLY-75). */
import { act, cleanup, render, screen, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { afterEach, vi } from 'vitest';
import type { FleetSettingsV1 } from '../../src/core/index.ts';
import { App } from '../../src/ui/App.tsx';
import {
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
import { enter, setupUser } from './user.ts';

afterEach(cleanup);

export const CREATOR = 'FQ6WmS5szfK1NRVcGkAqeVbwNeL9kt4xJXhwviyWTB7K';
export const FLEET_ADDRESS = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
export const MINT = 'HEhuwZjGd8Za7jgjzzpsXJssnP89DQm4oYHghRpnpump';
export const SIG = `${'3'.repeat(40)}${'A'.repeat(48)}`;
/** Why Buy and Sell of an armed group are off (the Sell text before BUNNDLY-86). */
export const ARMED_REASON = 'DISARM first: the armed watcher may buy this token at any moment.';

/** Mock Web Audio: counts the tones. */
export function mockAudio() {
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
export function mockWakeLock(refuse = false) {
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

export interface Setup {
  readonly global?: Partial<FleetSettingsV1['global']>;
  readonly helius?: boolean;
  readonly maxSpend?: boolean;
  readonly browser?: Partial<WatchBrowser>;
  readonly alarmRepeatMs?: number;
}

export function detection(extra: Partial<WatchDetection> = {}): WatchDetection {
  return {
    mint: MINT,
    source: 'pump.fun',
    path: 'log',
    slot: null,
    signature: SIG,
    detectedAt: Date.UTC(2026, 9, 3, 12, 0, 5),
    runId: 1,
    reactionMs: 4.2,
    verified: true,
    problem: null,
    ...extra,
  };
}

export function setup(o: Setup = {}) {
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
      case 'stop': // STOP disarms too (BUNNDLY-87)
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
export async function openTabB(): Promise<void> {
  await screen.findByText(/^Slot \S+ · /u);
}

/** Types a creator into the command bar and waits until the worker named it a wallet. */
export async function typeCreator(user: UserEvent, creator = CREATOR): Promise<void> {
  // these tests send to every wallet at once; Stairs is the default since BUNNDLY-93
  await user.click(screen.getByRole('button', { name: 'Immediate' }));
  await enter(user, screen.getByLabelText(TARGET_LABEL), creator);
  await screen.findByText('Creator wallet', {}, TARGET_WAIT);
}

export const armButton = () => screen.getByRole('button', { name: 'Arm' });

/** Opens a screen from the top bar (Dashboard, Activity, Settings). */
export async function goTo(user: UserEvent, name: string): Promise<void> {
  await user.click(within(screen.getByRole('navigation')).getByRole('button', { name }));
}

export async function arm(user: UserEvent): Promise<void> {
  await openTabB();
  await typeCreator(user);
  await user.click(armButton());
  await screen.findByRole('button', { name: 'Disarm' });
}
