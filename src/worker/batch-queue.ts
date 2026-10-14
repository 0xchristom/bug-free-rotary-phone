/**
 * Work that may be asked for in bursts but must reach the RPC at a steady pace (BUNNDLY-57):
 * items asked for close together share one run, and runs start at least `gapMs` apart. The
 * first run after a quiet spell starts at once.
 */
export interface BatchQueueDeps<K, V> {
  readonly clock: { now(): number; sleep(ms: number): Promise<void> };
  readonly gapMs: number;
  /** One run with everything asked for since the last one: key → values. */
  readonly run: (batch: ReadonlyMap<K, ReadonlySet<V>>) => Promise<void>;
}

export interface BatchQueue<K, V> {
  add(key: K, value: V): void;
  /** Drops what was asked for and not run yet (e.g. the vault locked). */
  clear(): void;
}

export function createBatchQueue<K, V>(deps: BatchQueueDeps<K, V>): BatchQueue<K, V> {
  let pending = new Map<K, Set<V>>();
  let scheduled = false;
  let lastRun = Number.NEGATIVE_INFINITY;
  return {
    add(key, value) {
      const values = pending.get(key) ?? new Set<V>();
      values.add(value);
      pending.set(key, values);
      if (scheduled) return; // joins the run already on its way
      scheduled = true;
      const wait = Math.max(0, lastRun + deps.gapMs - deps.clock.now());
      void deps.clock.sleep(wait).then(async () => {
        scheduled = false;
        lastRun = deps.clock.now();
        const batch = pending;
        pending = new Map();
        if (batch.size > 0) await deps.run(batch);
      });
    },
    clear() {
      pending = new Map();
    },
  };
}
