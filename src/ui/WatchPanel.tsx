import { useEffect, useId, useState } from 'react';
import { toUserMessage } from '../core/errors.ts';
import type { BuyMode } from '../core/settings.ts';
import type { ApiKeyFlags } from '../worker/protocol.ts';
import type { WatchDetection } from '../watcher/watch.ts';
import { formatSol } from './sol.ts';
import { useVault } from './vault-state.ts';
import {
  isCreatorAddress,
  PATH_LABELS,
  SOURCE_LABELS,
  connectionLabel,
  connectionTone,
  problemLabel,
} from './watch-labels.ts';
import { useWatchRuntime } from './watch-runtime.ts';

export interface WatchPanelProps {
  readonly readyCount: number;
  readonly toSpend: bigint;
  readonly dryRun: boolean;
  /** A buy runs (mode A or B): arming waits for it. */
  readonly buyRunning: boolean;
  /** Why buying is blocked now (e.g. unsaved table), or null. */
  readonly blocked: string | null;
  readonly fleetAddresses: readonly string[];
  readonly apiKeys: ApiKeyFlags;
  readonly mode: BuyMode;
  /** Saves the one-shot/continuous setting in the vault. */
  readonly onMode: (mode: BuyMode) => Promise<void>;
}

const MODE_HELP: Readonly<Record<BuyMode, string>> = {
  'one-shot': 'Jednorazowy: pierwszy wykryty token rozbraja watcher, a zakup trwa dalej.',
  continuous:
    'Ciągły: watcher zostaje uzbrojony i kupuje każdy kolejny token twórcy, jeden po drugim.',
};

function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

function verifiedLabel(d: WatchDetection): string {
  if (d.verified === true) return 'zweryfikowane';
  if (d.verified === false) return 'niezgodne z transakcją';
  return '–';
}

/**
 * Mode B controls (SPEC 3.4, BUNNDLY-35, D-039): the creator address, one-shot or
 * continuous, the big UZBRÓJ / ROZBRÓJ button (live mode only after a confirmation),
 * the connection state and the detections.
 */
export function WatchPanel({
  readyCount,
  toSpend,
  dryRun,
  buyRunning,
  blocked,
  fleetAddresses,
  apiKeys,
  mode,
  onMode,
}: WatchPanelProps) {
  const { client, status, refresh } = useVault();
  const { alarm, wake } = useWatchRuntime();
  const ids = useId();
  const watch = status?.watch ?? null;
  const armed = watch?.armed ?? false;
  const [creatorText, setCreatorText] = useState('');
  const [confirmArm, setConfirmArm] = useState(false);
  const [confirmContinuous, setConfirmContinuous] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // "Last message N s ago" moves while the watcher has a connection to show.
  useEffect(() => {
    if (watch === null) return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1_000);
    return () => {
      clearInterval(timer);
    };
  }, [watch]);

  const creator = creatorText.trim();
  const creatorValid = isCreatorAddress(creator);
  const inFleet = creatorValid && fleetAddresses.includes(creator);
  const hasHelius =
    (apiKeys.helius || apiKeys.heliusWsUrl) && (apiKeys.helius || apiKeys.heliusRpcUrl);
  const missing =
    blocked ??
    (!hasHelius
      ? 'Obserwacja wymaga klucza Helius (Ustawienia).'
      : readyCount === 0
        ? 'Brak gotowych portfeli: zaznacz aktywne i ustaw im max spend.'
        : !creatorValid
          ? 'Podaj poprawny adres twórcy.'
          : buyRunning
            ? 'Trwa zakup: uzbroisz watcher po jego końcu.'
            : null);

  const act = async (task: () => Promise<unknown>): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      await task();
    } catch (e) {
      setError(toUserMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const arm = (): void => {
    setConfirmArm(false);
    alarm.prime(); // the click allows the alarm sound later (autoplay policy)
    void act(async () => {
      await client.request({ type: 'arm', creator });
      await refresh();
    });
  };
  const disarm = (): void => {
    void act(async () => {
      await client.request({ type: 'disarm' });
      await refresh();
    });
  };
  const onArmClick = (): void => {
    if (dryRun) arm();
    else setConfirmArm(true);
  };
  const chooseMode = (next: BuyMode): void => {
    setConfirmContinuous(false);
    void act(() => onMode(next));
  };
  const copy = async (mint: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(mint);
      setCopied(mint);
    } catch {
      setCopied(null);
      setError('Nie udało się skopiować adresu. Zaznacz go i skopiuj ręcznie.');
    }
  };

  const detections = watch?.detections ?? [];
  const queued = new Set(watch?.queued ?? []);
  const secondsAgo =
    watch?.lastMessageAt == null
      ? null
      : Math.max(0, Math.round((now - watch.lastMessageAt) / 1000));

  return (
    <div className="watch-panel">
      {armed && watch ? (
        <p>
          Obserwowany twórca: <code className="address">{watch.creator}</code>
        </p>
      ) : (
        <div className="field">
          <label htmlFor={`${ids}-creator`}>Adres twórcy</label>
          <input
            id={`${ids}-creator`}
            type="text"
            value={creatorText}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={creator !== '' && !creatorValid}
            aria-describedby={`${ids}-creator-help`}
            onChange={(e) => {
              setCreatorText(e.target.value);
            }}
          />
          {creator !== '' && !creatorValid ? (
            <p className="field-error" id={`${ids}-creator-help`} role="alert">
              To nie jest prawidłowy adres portfela (base58, 32 bajty, inny niż mint SOL).
            </p>
          ) : (
            <p className="hint" id={`${ids}-creator-help`}>
              Portfel, który utworzy token. Watcher kupi każdy nowy token, który ten adres podpisze.
            </p>
          )}
          {inFleet && (
            <p className="notice warning" role="status">
              To adres portfela z tej floty. Upewnij się, że chcesz obserwować własny portfel.
            </p>
          )}
        </div>
      )}

      <fieldset className="watch-mode" disabled={armed || busy}>
        <legend>Po wykryciu</legend>
        {(['one-shot', 'continuous'] as const).map((m) => (
          <label key={m} className="inline">
            <input
              type="radio"
              name={`${ids}-mode`}
              checked={mode === m}
              onChange={() => {
                if (m === 'continuous') setConfirmContinuous(true);
                else chooseMode(m);
              }}
            />
            {m === 'one-shot' ? 'jednorazowy' : 'ciągły'}
          </label>
        ))}
        <p className="hint">{MODE_HELP[mode]}</p>
      </fieldset>
      {confirmContinuous && (
        <div
          className="notice warning"
          role="alertdialog"
          aria-labelledby={`${ids}-cont-title`}
          aria-describedby={`${ids}-cont-text`}
        >
          <p id={`${ids}-cont-title`}>
            <strong>Włączyć tryb ciągły?</strong>
          </p>
          <p id={`${ids}-cont-text`}>
            Watcher nie rozbroi się po pierwszym tokenie: każdy kolejny token twórcy uruchomi
            następny zakup całej floty.
          </p>
          <div className="actions">
            <button
              type="button"
              className="danger"
              onClick={() => {
                chooseMode('continuous');
              }}
            >
              Tak, tryb ciągły
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirmContinuous(false);
              }}
            >
              Anuluj
            </button>
          </div>
        </div>
      )}

      {watch && (
        <p className={`connection ${connectionTone(watch.connection)}`} role="status">
          Połączenie: <strong>{connectionLabel(watch.connection, watch.attempt)}</strong>
          {secondsAgo !== null && ` · ostatnia wiadomość ${String(secondsAgo)} s temu`}
          {!armed && ' · watcher rozbrojony'}
        </p>
      )}

      {confirmArm && !armed && (
        <div
          className="notice warning"
          role="alertdialog"
          aria-labelledby={`${ids}-arm-title`}
          aria-describedby={`${ids}-arm-text`}
        >
          <p id={`${ids}-arm-title`}>
            <strong>Uzbroić watcher w trybie na żywo?</strong>
          </p>
          <p id={`${ids}-arm-text`}>
            Po wykryciu tokenu flota kupi automatycznie: do {formatSol(toSpend)} SOL z {readyCount}{' '}
            {readyCount === 1 ? 'portfela' : 'portfeli'}
            {mode === 'continuous' ? ' przy każdym tokenie' : ''}. Transakcji na łańcuchu nie da się
            cofnąć.
          </p>
          <div className="actions">
            <button type="button" className="danger" onClick={arm}>
              Tak, uzbrój
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirmArm(false);
              }}
            >
              Anuluj
            </button>
          </div>
        </div>
      )}

      <div className="actions">
        {armed ? (
          <button type="button" className="arm armed" disabled={busy} onClick={disarm}>
            ROZBRÓJ
          </button>
        ) : (
          <button
            type="button"
            className="arm"
            disabled={busy || confirmArm || missing !== null}
            onClick={onArmClick}
          >
            {busy ? 'Uzbrajanie…' : 'UZBRÓJ'}
          </button>
        )}
        {!armed && missing && <span className="muted">{missing}</span>}
      </div>

      {armed && (
        <p className="notice warning" role="status">
          Watcher jest uzbrojony. Nie zamykaj ani nie przeładowuj tej karty: obserwacja i zakup
          działają tylko w niej.
          {wake === 'unavailable' &&
            ' Ekran może zgasnąć: przeglądarka nie utrzyma go włączonego, a uśpiony komputer nie wykryje tokenu.'}
        </p>
      )}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}

      {detections.length > 0 && (
        <div className="table-wrap">
          <table className="detections">
            <caption>Wykrycia</caption>
            <thead>
              <tr>
                <th scope="col">Czas</th>
                <th scope="col">Mint</th>
                <th scope="col">Źródło</th>
                <th scope="col">Ścieżka</th>
                <th scope="col">Reakcja</th>
                <th scope="col">Weryfikacja</th>
                <th scope="col">Wynik</th>
              </tr>
            </thead>
            <tbody>
              {detections.map((d) => (
                <tr key={`${d.mint}-${d.signature}`}>
                  <td>{new Date(d.detectedAt).toLocaleTimeString('pl-PL')}</td>
                  <td>
                    <code title={d.mint}>{shortAddress(d.mint)}</code>{' '}
                    <button
                      type="button"
                      aria-label={`Kopiuj mint ${d.mint}`}
                      onClick={() => void copy(d.mint)}
                    >
                      {copied === d.mint ? 'Skopiowano' : 'Kopiuj'}
                    </button>
                  </td>
                  <td>{SOURCE_LABELS[d.source]}</td>
                  <td>{PATH_LABELS[d.path]}</td>
                  <td>{d.reactionMs === null ? '–' : `${String(Math.round(d.reactionMs))} ms`}</td>
                  <td className={d.verified === false ? 'danger' : undefined}>
                    {verifiedLabel(d)}
                  </td>
                  <td>
                    {d.problem !== null
                      ? problemLabel(d.problem)
                      : queued.has(d.mint)
                        ? 'w kolejce'
                        : d.runId !== null
                          ? `zakup #${String(d.runId)}`
                          : 'start zakupu…'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
