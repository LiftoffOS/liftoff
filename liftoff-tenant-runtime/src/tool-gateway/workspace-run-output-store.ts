/**
 * R5 Fix 2 (SE-R5-006): In-memory last-output store for workspace_run.
 *
 * Replaces R4's filesystem symlink approach which exposed an agent-writable
 * indirection. Store keyed by threadId; TTL 15 min; LRU eviction when size
 * exceeds 10,000 entries.
 *
 * Caveat: Cloud Run multi-instance means the last output may live on a
 * different instance than the current turn. Chat-turn locks ensure a thread's
 * turn is on one instance at a time, so same-turn queries always succeed.
 * Cross-turn queries are best-effort; agent can re-run if needed.
 */
const MAX_ENTRIES = 10_000;
const TTL_MS = 15 * 60 * 1000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export interface LastOutputEntry {
  runId: string;
  stdout: string;
  stderr: string;
  capturedAt: number;
}

const store = new Map<string, LastOutputEntry>();

function evictIfNeeded(): void {
  if (store.size <= MAX_ENTRIES) return;
  const cutoff = Date.now() - TTL_MS;
  for (const [k, v] of store) {
    if (v.capturedAt < cutoff) {
      store.delete(k);
    }
  }
  if (store.size > MAX_ENTRIES) {
    // Still over — drop oldest until back under cap
    const sorted = Array.from(store.entries()).sort((a, b) => a[1].capturedAt - b[1].capturedAt);
    const toDrop = sorted.length - MAX_ENTRIES;
    for (let i = 0; i < toDrop; i++) {
      store.delete(sorted[i][0]);
    }
  }
}

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT_BYTES) return s;
  return s.slice(0, MAX_OUTPUT_BYTES) + '\n... [truncated]';
}

export function storeLastOutput(threadId: string, entry: Omit<LastOutputEntry, 'capturedAt'>): void {
  store.set(threadId, {
    runId: entry.runId,
    stdout: truncate(entry.stdout),
    stderr: truncate(entry.stderr),
    capturedAt: Date.now(),
  });
  evictIfNeeded();
}

export function getLastOutput(threadId: string): LastOutputEntry | null {
  const entry = store.get(threadId);
  if (!entry) return null;
  if (Date.now() - entry.capturedAt > TTL_MS) {
    store.delete(threadId);
    return null;
  }
  return entry;
}

export function clearLastOutput(threadId: string): void {
  store.delete(threadId);
}

/** Test-only. */
export function _resetStoreForTesting(): void {
  store.clear();
}
