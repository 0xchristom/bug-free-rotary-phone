/**
 * Fast path (BUNNDLY-33, D-037): the new mint straight from a `processed` log, with no RPC
 * call. SPEC 5 wants a reaction under 300 ms, and `getTransaction` works only from
 * `confirmed`, usually a few hundred ms later.
 *
 * Only pump.fun writes its launch event (`CreateEvent`) to the log. Meteora DBC emits
 * `EvtInitializePool` through a self-CPI (`emit_cpi!`), so it never reaches the log
 * (checked on real transactions, D-037): DBC, LaunchLab and the fallback take the slow path.
 * A long log can be truncated by the runtime ("Log truncated"); then the slow path finds
 * the mint a few hundred ms later.
 *
 * `Program data:` lines are Anchor events. Each is assigned to the program on top of the
 * `invoke` stack, so data written by another program never counts. An event counts only
 * when its signer field (pump.fun `user`) is the watched address: the
 * pump.fun `creator` field alone is not enough, anyone can name someone else as creator.
 */
import { base58, base64 } from '@scure/base';
import {
  KNOWN_MINTS,
  PUMP_CREATE_EVENT,
  PUMP_FUN_PROGRAM,
  type DetectionSource,
} from './programs.ts';

export interface ProgramData {
  readonly program: string;
  readonly data: Uint8Array;
}

const INVOKE = /^Program (\S+) invoke \[\d+\]$/u;
const RESULT = /^Program (\S+) (success|failed)/u;
const DATA = /^Program data: (.+)$/u;

/** Every `Program data:` payload with the program that wrote it (top of the invoke stack). */
export function programData(logs: readonly string[]): ProgramData[] {
  const stack: string[] = [];
  const out: ProgramData[] = [];
  for (const line of logs) {
    const invoke = INVOKE.exec(line);
    if (invoke?.[1] !== undefined) {
      stack.push(invoke[1]);
      continue;
    }
    const result = RESULT.exec(line);
    if (result?.[1] !== undefined) {
      if (stack.at(-1) === result[1]) stack.pop();
      continue;
    }
    const data = DATA.exec(line);
    const program = stack.at(-1);
    if (data?.[1] === undefined || program === undefined) continue;
    // Several base64 chunks may share one line.
    for (const chunk of data[1].split(' ')) {
      try {
        out.push({ program, data: base64.decode(chunk) });
      } catch {
        // not base64: ignore
      }
    }
  }
  return out;
}

function startsWith(data: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.every((b, i) => data[i] === b);
}

/** Minimal Borsh reader for the fields we need. */
class Reader {
  private offset: number;
  constructor(
    private readonly data: Uint8Array,
    offset: number,
  ) {
    this.offset = offset;
  }
  string(): void {
    const view = new DataView(this.data.buffer, this.data.byteOffset + this.offset, 4);
    const length = view.getUint32(0, true);
    this.offset += 4 + length;
    if (this.offset > this.data.length) throw new RangeError('string');
  }
  pubkey(): string {
    const end = this.offset + 32;
    if (end > this.data.length) throw new RangeError('pubkey');
    const key = base58.encode(this.data.subarray(this.offset, end));
    this.offset = end;
    return key;
  }
}

export interface LogDetection {
  readonly mint: string;
  readonly source: DetectionSource;
}

/** pump.fun `CreateEvent`: name, symbol, uri, mint, bonding_curve, user, creator, … */
function pumpCreate(data: Uint8Array): { mint: string; signer: string } | null {
  if (!startsWith(data, PUMP_CREATE_EVENT)) return null;
  const r = new Reader(data, 8);
  r.string();
  r.string();
  r.string();
  const mint = r.pubkey();
  r.pubkey(); // bonding_curve
  const user = r.pubkey();
  return { mint, signer: user };
}

const DECODERS: Readonly<
  Record<
    string,
    { source: DetectionSource; decode: (d: Uint8Array) => ReturnType<typeof pumpCreate> }
  >
> = {
  [PUMP_FUN_PROGRAM]: { source: 'pump.fun', decode: pumpCreate },
};

/** New mints whose launch event names the watched address as its signer. Never throws. */
export function detectFromLogs(logs: readonly string[], watched: string): LogDetection[] {
  const found: LogDetection[] = [];
  for (const { program, data } of programData(logs)) {
    const decoder = DECODERS[program];
    if (decoder === undefined) continue;
    let event: ReturnType<typeof pumpCreate>;
    try {
      event = decoder.decode(data);
    } catch {
      continue; // truncated or another event layout
    }
    if (event === null || event.signer !== watched || KNOWN_MINTS.has(event.mint)) continue;
    if (!found.some((f) => f.mint === event.mint))
      found.push({ mint: event.mint, source: decoder.source });
  }
  return found;
}
