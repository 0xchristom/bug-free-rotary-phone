/**
 * Browser side of mode B (SPEC 3.4, BUNNDLY-35, D-039): the alarm sound (Web Audio, an
 * oscillator: no files, nothing outside the CSP) and the screen Wake Lock. Both APIs are
 * injected so the UI can be tested with mocks.
 */
import { createContext, useContext, useEffect, useState } from 'react';

export interface OscillatorLike {
  type: string;
  readonly frequency: { value: number };
  connect(node: unknown): unknown;
  start(when?: number): void;
  stop(when?: number): void;
}

export interface GainLike {
  readonly gain: { value: number };
  connect(node: unknown): unknown;
}

/** The part of `AudioContext` the alarm uses. */
export interface AudioContextLike {
  readonly currentTime: number;
  readonly destination: unknown;
  createOscillator(): OscillatorLike;
  createGain(): GainLike;
  resume(): Promise<void>;
}

export interface WakeLockSentinelLike {
  readonly released: boolean;
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
}

/** `navigator.wakeLock`. */
export interface WakeLockLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

export interface WatchBrowser {
  /** Null when the browser has no Web Audio. */
  readonly createAudioContext: (() => AudioContextLike) | null;
  /** Null when the browser has no Wake Lock API. */
  readonly wakeLock: WakeLockLike | null;
}

export function browserWatchApis(): WatchBrowser {
  const Ctx = typeof AudioContext === 'function' ? AudioContext : null;
  const wakeLock =
    typeof navigator !== 'undefined' && 'wakeLock' in navigator ? navigator.wakeLock : null;
  return {
    createAudioContext: Ctx === null ? null : () => new Ctx(),
    wakeLock,
  };
}

/** Alarm repeats this often while the connection is lost. */
export const ALARM_REPEAT_MS = 3_000;
const BEEP_SECONDS = 0.4;
const BEEP_HZ = 880;

/**
 * Alarm sound. Browsers let a page play sound only after a user gesture, so the
 * `AudioContext` is made in `prime()`, called from the click on UZBRÓJ.
 */
export class AlarmSound {
  private context: AudioContextLike | null = null;

  constructor(private readonly create: (() => AudioContextLike) | null) {}

  /** From a click: creates (or resumes) the audio context. */
  prime(): void {
    if (this.create === null) return;
    try {
      this.context ??= this.create();
      void this.context.resume().catch(() => undefined);
    } catch {
      this.context = null; // no sound, the banner still shows
    }
  }

  /** One short tone; nothing without a primed context. */
  beep(): void {
    const ctx = this.context;
    if (ctx === null) return;
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = BEEP_HZ;
      gain.gain.value = 0.15;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + BEEP_SECONDS);
    } catch {
      // a failing audio device must not break the page
    }
  }
}

/** What the mode B UI shares: the alarm (primed on UZBRÓJ) and the Wake Lock state. */
export interface WatchRuntime {
  readonly alarm: AlarmSound;
  readonly wake: WakeState;
  /** How often the tone repeats while the connection is lost. */
  readonly alarmRepeatMs: number;
}

export const WatchRuntimeContext = createContext<WatchRuntime | null>(null);

export function useWatchRuntime(): WatchRuntime {
  const runtime = useContext(WatchRuntimeContext);
  if (runtime === null) throw new Error('useWatchRuntime outside WatchRuntimeContext');
  return runtime;
}

/** `held`: the screen stays on; `unavailable`: no API or the browser said no. */
export type WakeState = 'off' | 'held' | 'unavailable';

/**
 * Screen Wake Lock while `active`: requested at once, requested again when the tab is
 * visible again (the browser drops the lock when the tab is hidden), released when not
 * active. A missing API or a refusal is a state, never an error.
 */
export function useWakeLock(active: boolean, wakeLock: WakeLockLike | null): WakeState {
  /** Result of the last request while active; reset when the lock is let go. */
  const [state, setState] = useState<'pending' | 'held' | 'unavailable'>('pending');
  useEffect(() => {
    if (!active || wakeLock === null) return;
    let sentinel: WakeLockSentinelLike | null = null;
    let alive = true;
    const acquire = (): void => {
      if (sentinel !== null && !sentinel.released) return;
      wakeLock.request('screen').then(
        (s) => {
          if (!alive) {
            void s.release().catch(() => undefined);
            return;
          }
          sentinel = s;
          setState('held');
          s.addEventListener('release', () => {
            if (alive) setState('unavailable');
          });
        },
        () => {
          if (alive) setState('unavailable');
        },
      );
    };
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') acquire();
    };
    acquire();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onVisibility);
      if (sentinel !== null && !sentinel.released) void sentinel.release().catch(() => undefined);
      setState('pending');
    };
  }, [active, wakeLock]);
  if (!active) return 'off';
  if (wakeLock === null) return 'unavailable';
  return state === 'pending' ? 'off' : state;
}
