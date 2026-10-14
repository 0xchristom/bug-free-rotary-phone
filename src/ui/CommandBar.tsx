import {
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { TargetKind } from '../chain/target.ts';
import { toUserMessage } from '../core/errors.ts';
import type { WatchDetection, WatchStatus } from '../watcher/watch.ts';
import {
  connectionLabel,
  connectionTone,
  isCreatorAddress,
  SOURCE_LABELS,
} from './watch-labels.ts';
import { shortAddress } from './short-address.ts';
import { useVault } from './vault-state.ts';
import { AimIcon, Button, Chip, InIcon, OutIcon, StopIcon, cx } from './kit/index.ts';

/** What the target field holds once the worker read the account. */
export interface Target {
  readonly address: string;
  readonly kind: TargetKind;
}

/** Why each command is off right now; null = it can run. */
export interface CommandReasons {
  readonly buy: string | null;
  readonly arm: string | null;
  readonly sell: string | null;
  readonly stop: string | null;
}

export interface CommandBarProps {
  /** The target field's text; the screen keeps one per wallet group (BUNNDLY-69). */
  readonly text: string;
  readonly onText: (text: string) => void;
  /** The shown group's watcher (its last arming), or null. */
  readonly watch: WatchStatus | null;
  /** The browser cannot keep the screen on while the watcher is armed. */
  readonly wakeUnavailable: boolean;
  readonly busy: boolean;
  readonly reasons: CommandReasons;
  /** Why no command can run for this fleet at all (e.g. Devnet); shown with or without a target. */
  readonly blocked: string | null;
  /**
   * Something to set up first (no Helius key), said in the strip's status instead of a
   * separate error line (BUNNDLY-73); null when nothing is missing.
   */
  readonly setup?: string | null;
  /** The newest token the watcher found (mode B), shown as a chip; Buy can buy it. */
  readonly detected: WatchDetection | null;
  /** Called with the checked target, or null while the field is empty, wrong or checking. */
  readonly onTarget: (target: Target | null) => void;
  readonly onArm: () => void;
  readonly onDisarm: () => void;
  /** Short messages about the target and the last command, under the strip. */
  readonly children?: ReactNode;
}

/** Waits this long after the last keystroke before asking the worker. */
const CHECK_DELAY_MS = 250;

type Check =
  | { readonly kind: 'empty' }
  | { readonly kind: 'checking'; readonly address: string }
  | { readonly kind: 'done'; readonly target: Target }
  | { readonly kind: 'error'; readonly message: string };

function kindLabel(kind: TargetKind): string {
  if (kind.kind === 'wallet') return 'Creator wallet';
  return kind.program === 'token-2022' ? 'Token · Token-2022' : 'Token · SPL';
}

/** Keys typed into a field, a select or an editable element are text, not commands. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

/**
 * The target strip of the Dashboard (SPEC 11.4, BUNNDLY-59, mockup v2): one field for a
 * token mint or a creator wallet, read by the worker, and on the right what the watcher
 * does, with Arm / Disarm. Buy, Sell and Stop are in the toolbar (CommandButtons).
 */
export function CommandBar({
  text,
  onText,
  watch,
  wakeUnavailable,
  busy,
  reasons,
  blocked,
  setup = null,
  detected,
  onTarget,
  onArm,
  onDisarm,
  children,
}: CommandBarProps) {
  const { client } = useVault();
  const ids = useId();
  /** The worker's last answer, for the address it was asked about. */
  const [answer, setAnswer] = useState<
    | { readonly address: string; readonly kind: TargetKind }
    | { readonly address: string; readonly error: string }
    | null
  >(null);

  const address = text.trim();
  const wellFormed = isCreatorAddress(address);
  const check: Check =
    address === ''
      ? { kind: 'empty' }
      : !wellFormed
        ? {
            kind: 'error',
            message: 'Paste a full Solana address: a token mint or a creator wallet.',
          }
        : answer?.address !== address
          ? { kind: 'checking', address }
          : 'kind' in answer
            ? { kind: 'done', target: { address, kind: answer.kind } }
            : { kind: 'error', message: answer.error };

  // Ask the worker what the address is; an answer for older text is dropped.
  useEffect(() => {
    if (!wellFormed) return;
    let current = true;
    const timer = setTimeout(() => {
      client.request({ type: 'classifyTarget', address }).then(
        (kind) => {
          if (current) setAnswer({ address, kind });
        },
        (e: unknown) => {
          if (current) setAnswer({ address, error: toUserMessage(e) });
        },
      );
    }, CHECK_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [address, wellFormed, client]);

  // The screen learns the checked target (or that there is none) once per change.
  const target = check.kind === 'done' ? check.target : null;
  // `target` is a new object on every render: its address and kind decide.
  const targetKey = target === null ? null : `${target.kind.kind}:${target.address}`;
  const report = useEffectEvent(() => {
    onTarget(target);
  });
  // Before paint: the screen's reasons and the chip change in the same frame.
  useLayoutEffect(() => {
    report();
  }, [targetKey]);

  const armed = watch?.armed ?? false;
  const [now, setNow] = useState(() => Date.now());
  // "Last message N s ago" moves while the watcher is armed.
  useEffect(() => {
    if (!armed) return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1_000);
    return () => {
      clearInterval(timer);
    };
  }, [armed]);
  const secondsAgo =
    watch?.lastMessageAt == null
      ? null
      : Math.max(0, Math.round((now - watch.lastMessageAt) / 1000));
  const helpId = `${ids}-help`;
  // One sentence under the strip: why the command that fits the target is off.
  const why =
    blocked ??
    (target?.kind.kind === 'wallet' && !armed
      ? reasons.arm
      : target !== null || detected !== null
        ? reasons.buy
        : null);
  const tone = watch === null || !armed ? undefined : connectionTone(watch.connection);

  return (
    <section className="target" aria-label="Commands">
      <label htmlFor={`${ids}-target`} className="target-label">
        Target
      </label>
      <div className={cx('field', check.kind === 'error' && 'invalid')}>
        <input
          id={`${ids}-target`}
          aria-label="Target: token mint or creator wallet"
          value={text}
          placeholder="Token address, or a creator wallet to watch"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={check.kind === 'error' ? true : undefined}
          aria-describedby={helpId}
          onChange={(e) => {
            onText(e.target.value);
          }}
        />
        {check.kind === 'checking' && <Chip tone="muted">Checking…</Chip>}
        {target && (
          <Chip tone={target.kind.kind === 'wallet' ? 'watch' : 'ok'}>
            {kindLabel(target.kind)}
          </Chip>
        )}
      </div>
      {detected && (
        <Chip tone="watch" aria-label={`Detected token ${detected.mint}`}>
          <span title={detected.mint}>
            Detected {shortAddress(detected.mint)} · {SOURCE_LABELS[detected.source]}
          </span>
        </Chip>
      )}
      <div className="watchline">
        <span
          className={cx('pulse', armed ? 'armed' : target?.kind.kind === 'mint' && 'live')}
          aria-hidden="true"
        />
        <span className="watchtext">
          {armed && watch ? (
            <>
              <b>Armed</b> · watching {shortAddress(watch.creator)} ·{' '}
              <span className="conn" data-tone={tone}>
                {connectionLabel(watch.connection, watch.attempt)}
              </span>
              {secondsAgo !== null && (
                <span className="muted"> · last message {String(secondsAgo)} s ago</span>
              )}
            </>
          ) : setup !== null ? (
            <span className="conn" data-tone="wait">
              {setup}
            </span>
          ) : target?.kind.kind === 'wallet' ? (
            'Arm the fleet to buy the creator’s next token'
          ) : target ? (
            <>
              <b>Ready</b> · Buy and Sell act on the selected wallets
            </>
          ) : (
            'Paste a target to begin'
          )}
        </span>
        {armed ? (
          <Button variant="watch" icon={<AimIcon />} disabled={busy} onClick={onDisarm}>
            Disarm
          </Button>
        ) : (
          target?.kind.kind === 'wallet' && (
            <Button
              variant="watch"
              icon={<AimIcon />}
              disabled={reasons.arm !== null}
              title={reasons.arm ?? undefined}
              aria-description={reasons.arm ?? undefined}
              onClick={onArm}
            >
              Arm
            </Button>
          )
        )}
      </div>
      {/* Out of the notes row, so an empty row takes no height (it is absolutely placed). */}
      {check.kind !== 'error' && (
        <p className="sr-only" id={helpId}>
          {target?.kind.kind === 'wallet'
            ? 'Arm watches this wallet and buys every new token it creates.'
            : target
              ? 'Buy buys this token with the selected wallets.'
              : 'A token mint to buy now, or a creator wallet to watch. Not saved in the fleet file.'}
        </p>
      )}
      <div className="target-notes">
        {check.kind === 'error' && (
          <p className="field-error" id={helpId} role="alert">
            {check.message}
          </p>
        )}
        {why && <p className="muted cmd-why">{why}</p>}
        {armed && (
          <p className="muted" role="status">
            The watcher is armed. Do not close or reload this tab: the watcher and the buy live only
            in it.
            {wakeUnavailable &&
              ' The screen may turn off: the browser cannot keep it on, and a sleeping computer will not detect the token.'}
          </p>
        )}
        {children}
      </div>
    </section>
  );
}

export interface CommandButtonsProps {
  readonly reasons: CommandReasons;
  readonly onBuy: () => void;
  readonly onSell: () => void;
  readonly onStop: () => void;
}

/**
 * Buy, Sell and Stop on the right of the toolbar (mockup v2). Shortcuts: B buy, S sell,
 * Esc stop, never while typing in a field or with a dialog open. A command that cannot
 * run is disabled and its description says why.
 */
export function CommandButtons({ reasons, onBuy, onSell, onStop }: CommandButtonsProps) {
  const commands = useRef({ onBuy, onSell, onStop, reasons });
  useEffect(() => {
    commands.current = { onBuy, onSell, onStop, reasons };
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (isTyping(event.target)) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      const c = commands.current;
      const key = event.key.toLowerCase();
      if (key === 'b' && c.reasons.buy === null) {
        event.preventDefault();
        c.onBuy();
      } else if (key === 's' && c.reasons.sell === null) {
        event.preventDefault();
        c.onSell();
      } else if (key === 'escape' && c.reasons.stop === null) {
        event.preventDefault();
        c.onStop();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  return (
    <>
      <Button
        variant="success"
        icon={<InIcon />}
        shortcut="B"
        disabled={reasons.buy !== null}
        title={reasons.buy ?? 'Shortcut: B'}
        aria-description={reasons.buy ?? undefined}
        aria-keyshortcuts="B"
        onClick={onBuy}
      >
        Buy
      </Button>
      <Button
        variant="danger"
        icon={<OutIcon />}
        shortcut="S"
        disabled={reasons.sell !== null}
        title={reasons.sell ?? 'Shortcut: S'}
        aria-description={reasons.sell ?? undefined}
        aria-keyshortcuts="S"
        onClick={onSell}
      >
        Sell
      </Button>
      <Button
        variant="warn"
        icon={<StopIcon />}
        shortcut="Esc"
        disabled={reasons.stop !== null}
        title={reasons.stop ?? 'Shortcut: Esc'}
        aria-description={reasons.stop ?? undefined}
        aria-keyshortcuts="Escape"
        onClick={onStop}
      >
        Stop
      </Button>
    </>
  );
}
