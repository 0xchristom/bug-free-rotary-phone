import { useId, useState } from 'react';
import {
  CONNECTION_PROBLEMS,
  type ConnectionCheck,
  type ConnectionReport,
  type JupiterCheck,
  type RateLimitHeaders,
} from '../core/connection.ts';
import { toUserMessage } from '../core/errors.ts';
import { formatUnits } from './sol.ts';
import { useVault } from './vault-state.ts';

/** USDC has 6 decimals; the test asks for 0.01 SOL (jupiter/quote-check.ts). */
const USDC_DECIMALS = 6;

function timeOf(ms: number | null): string {
  return ms === null ? '–' : `${String(ms)} ms`;
}

function problemOf(check: ConnectionCheck): string {
  return check.problem === null ? '' : CONNECTION_PROBLEMS[check.problem];
}

/** Raw header values as received; the reset also as local time (D-024). */
function rateLimitText(limit: RateLimitHeaders): string {
  const parts: string[] = [];
  if (limit.remaining !== null) parts.push(`x-ratelimit-remaining ${String(limit.remaining)}`);
  if (limit.current !== null) parts.push(`x-ratelimit-current ${String(limit.current)}`);
  if (limit.reset !== null) {
    const time = new Date(limit.reset * 1000).toLocaleTimeString('en-GB');
    parts.push(`x-ratelimit-reset ${String(limit.reset)} (${time})`);
  }
  return parts.join(', ');
}

function jupiterDetails(j: JupiterCheck): string {
  const parts: string[] = [j.keyless ? 'Keyless plan (no key)' : 'with an API key'];
  if (j.outAmount !== null && j.router !== null) {
    parts.push(`0.01 SOL → ${formatUnits(BigInt(j.outAmount), USDC_DECIMALS)} USDC (${j.router})`);
  }
  parts.push(j.rateLimit ? rateLimitText(j.rateLimit) : 'x-ratelimit-* headers: not in the answer');
  return parts.join('; ');
}

interface Row {
  readonly name: string;
  readonly check: ConnectionCheck;
  readonly details: string;
}

function rowsOf(report: ConnectionReport): Row[] {
  const { heliusHttp: http, heliusWs: ws, jupiter } = report;
  return [
    {
      name: 'Helius HTTP (getHealth, getSlot)',
      check: http,
      details: http.slot === null ? '' : `slot ${String(http.slot)}`,
    },
    {
      name: 'Helius WebSocket (slotSubscribe)',
      check: ws,
      details:
        ws.firstEventMs === null
          ? ''
          : `connected in ${timeOf(ws.connectMs)}, first event after ${timeOf(ws.firstEventMs)}, slot ${String(ws.slot)}`,
    },
    {
      name: 'Jupiter (quote SOL → USDC, not executed)',
      check: jupiter,
      details: jupiterDetails(jupiter),
    },
  ];
}

/**
 * „Test połączeń” (SPEC 3.3). The vault worker runs the checks with the saved keys and
 * returns statuses and times only (D-024).
 */
export function ConnectionTest() {
  const { client } = useVault();
  const ids = useId();
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<ConnectionReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (): Promise<void> => {
    setRunning(true);
    setError(null);
    try {
      setReport(await client.request({ type: 'testConnections' }));
    } catch (e) {
      setReport(null);
      setError(toUserMessage(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <section aria-labelledby={`${ids}-title`}>
      <h3 id={`${ids}-title`}>Connection test</h3>
      <p className="muted">
        Checks Helius (HTTP and WebSocket) and Jupiter (a quote only, no transaction) with the keys
        saved in the vault. Unsaved key changes are not used.
      </p>
      <div className="actions">
        <button
          type="button"
          disabled={running}
          onClick={() => {
            void run();
          }}
        >
          {running ? 'Testing…' : 'Test connections'}
        </button>
      </div>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {report && (
        // Wrapped like the fleet table: on a phone the table scrolls, not the page.
        <div className="table-wrap">
          <table aria-label="Connection test results" className="connections">
            <thead>
              <tr>
                <th scope="col">Service</th>
                <th scope="col">Result and time</th>
                <th scope="col">Details</th>
              </tr>
            </thead>
            <tbody>
              {rowsOf(report).map((row) => (
                <tr key={row.name} className={row.check.ok ? '' : 'row-error'}>
                  <th scope="row">{row.name}</th>
                  <td>
                    {row.check.ok ? 'OK' : 'Error'}
                    {row.check.ms === null ? '' : `, ${timeOf(row.check.ms)}`}
                  </td>
                  <td>
                    {row.check.ok
                      ? row.details
                      : [problemOf(row.check), row.details].filter(Boolean).join(' ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
