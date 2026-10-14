import { useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState } from 'react';
import type { TargetKind } from '../chain/target.ts';
import { toUserMessage } from '../core/errors.ts';
import type { WatchDetection } from '../watcher/watch.ts';
import { isCreatorAddress, SOURCE_LABELS } from './watch-labels.ts';
import { shortAddress } from './short-address.ts';
import { useVault } from './vault-state.ts';
import { Button, Chip, Input } from './kit/index.ts';

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
  readonly dryRun: boolean;
  /** The watcher is armed: the bar shows DISARM and the watched creator. */
  readonly armed: boolean;
  readonly busy: boolean;
  readonly reasons: CommandReasons;
  /** Why no command can run for this fleet at all (e.g. Devnet); shown with or without a target. */
  readonly blocked: string | null;
  /** The newest token the watcher found (mode B), shown as a chip; BUY can buy it. */
  readonly detected: WatchDetection | null;
  /** Called with the checked target, or null while the field is empty, wrong or checking. */
  readonly onTarget: (target: Target | null) => void;
  readonly onBuy: () => void;
  readonly onSell: () => void;
  readonly onArm: () => void;
  readonly onDisarm: () => void;
  readonly onStop: () => void;
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
 * Command bar of the fleet (SPEC 11.4, BUNNDLY-59): one target field (a token mint or a
 * creator wallet, read by the worker) and ARM / BUY / SELL / STOP for the selected wallets.
 * A command that cannot run is disabled and says why. Shortcuts: B buy, S sell, Esc STOP,
 * never while typing in a field or with a dialog open.
 */
export function CommandBar({
  dryRun,
  armed,
  busy,
  reasons,
  blocked,
  detected,
  onTarget,
  onBuy,
  onSell,
  onArm,
  onDisarm,
  onStop,
}: CommandBarProps) {
  const { client } = useVault();
  const ids = useId();
  const [text, setText] = useState('');
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

  const helpId = `${ids}-help`;
  const whyId = `${ids}-why`;
  // One sentence under the bar: why the command that fits the target is off.
  const why =
    blocked ??
    (target?.kind.kind === 'wallet' && !armed
      ? reasons.arm
      : target !== null || detected !== null
        ? reasons.buy
        : null);

  return (
    <section className="cmd-bar" aria-label="Commands">
      <div className="cmd-row">
        <div className="cmd-target">
          <label htmlFor={`${ids}-target`} className="sr-only">
            Target: token mint or creator wallet
          </label>
          <Input
            id={`${ids}-target`}
            className="cmd-input"
            value={text}
            placeholder="Token mint or creator wallet"
            spellCheck={false}
            autoComplete="off"
            invalid={check.kind === 'error'}
            aria-describedby={helpId}
            onChange={(e) => {
              setText(e.target.value);
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
        <span className="spacer" />
        <Chip tone={dryRun ? 'sim' : 'danger'} aria-label={dryRun ? 'Mode: DRY-RUN' : 'Mode: live'}>
          {dryRun ? 'DRY-RUN' : 'LIVE'}
        </Chip>
        {armed ? (
          <Button variant="warn" disabled={busy} onClick={onDisarm}>
            DISARM
          </Button>
        ) : (
          <Button
            variant="watch"
            disabled={reasons.arm !== null}
            title={reasons.arm ?? undefined}
            aria-description={reasons.arm ?? undefined}
            onClick={onArm}
          >
            ARM
          </Button>
        )}
        <Button
          variant="success"
          disabled={reasons.buy !== null}
          title={reasons.buy ?? 'Shortcut: B'}
          aria-description={reasons.buy ?? undefined}
          aria-keyshortcuts="B"
          onClick={onBuy}
        >
          BUY
        </Button>
        <Button
          variant="danger"
          disabled={reasons.sell !== null}
          title={reasons.sell ?? 'Shortcut: S'}
          aria-description={reasons.sell ?? undefined}
          aria-keyshortcuts="S"
          onClick={onSell}
        >
          SELL
        </Button>
        <Button
          variant="warn"
          disabled={reasons.stop !== null}
          title={reasons.stop ?? 'Shortcut: Esc'}
          aria-description={reasons.stop ?? undefined}
          aria-keyshortcuts="Escape"
          onClick={onStop}
        >
          STOP
        </Button>
      </div>
      {check.kind === 'error' ? (
        <p className="field-error" id={helpId} role="alert">
          {check.message}
        </p>
      ) : (
        <p className="hint" id={helpId}>
          {target?.kind.kind === 'wallet'
            ? 'ARM watches this wallet and buys every new token it creates.'
            : target
              ? 'BUY buys this token with the selected wallets.'
              : 'A token mint to buy now, or a creator wallet to watch. Not saved in the fleet file.'}
        </p>
      )}
      {why && (
        <p className="muted cmd-why" id={whyId}>
          {why}
        </p>
      )}
    </section>
  );
}
