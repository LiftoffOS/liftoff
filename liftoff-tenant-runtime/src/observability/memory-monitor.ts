// Watching this process's own memory, between runs as well as during them.
//
// The run heartbeat already records RSS per invocation, which answers "was this
// run the one that died". It cannot answer the question that actually costs
// people time: whether the process is climbing steadily across runs. A leak
// looks like a healthy heartbeat until the container is killed, and a container
// killed by the platform leaves an OOM in the infrastructure log and nothing at
// all in ours — so the run that was in flight simply stops, and the stalled-run
// reconciler eventually files it as a stall with no cause.
//
// So: one line on an interval, always, whatever is happening. It is the only
// record that survives the kill, because it was written before it.
//
// Deliberately cheap and deliberately dumb — no sampling windows, no trend
// detection, no adaptive interval. Anything cleverer is a thing that can be
// wrong at exactly the moment it is needed.

import { scrubLogger } from './scrub-logger';

/** How often the line is written. A minute is short enough to catch a climb
 *  before the kill and long enough that a day of logs stays readable. */
export const MEMORY_SAMPLE_INTERVAL_MS = Number(process.env.MEMORY_SAMPLE_INTERVAL_MS ?? 60_000);

/** Fraction of the container limit past which the line is a warning rather than
 *  an info. Not an action — nothing is restarted or shed here — just the point
 *  at which somebody reading the logs should look. */
export const MEMORY_WARN_FRACTION = Number(process.env.MEMORY_WARN_FRACTION ?? 0.85);

let timer: NodeJS.Timeout | null = null;
let cachedLimitBytes: number | null | undefined;

/**
 * The container's memory limit, or null when it cannot be read.
 *
 * `MEMORY_LIMIT_MB` first because Terraform already knows the number it asked
 * Cloud Run for, and an explicit value beats inference. Falling back to the
 * cgroup file covers a deployment that did not set it.
 */
export function containerMemoryLimitBytes(): number | null {
  if (cachedLimitBytes !== undefined) return cachedLimitBytes;
  cachedLimitBytes = readLimit();
  return cachedLimitBytes;
}

function readLimit(): number | null {
  const declared = Number(process.env.MEMORY_LIMIT_MB);
  if (Number.isFinite(declared) && declared > 0) return declared * 1024 * 1024;
  try {
    // cgroup v2. "max" means unlimited, which is not a number and must not be
    // parsed as one — NaN compared against would silently disable the warning.
    const fs = require('fs') as typeof import('fs');
    for (const path of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
      if (!fs.existsSync(path)) continue;
      const raw = fs.readFileSync(path, 'utf8').trim();
      if (raw === 'max') return null;
      const n = Number(raw);
      // A cgroup with no limit reports a number near 2^63, which is not a
      // limit anybody is going to hit and would make every sample look fine.
      if (Number.isFinite(n) && n > 0 && n < 1e15) return n;
    }
  } catch { /* not on Linux, or no cgroup — no limit to report */ }
  return null;
}

export interface MemorySample {
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  limitBytes: number | null;
  /** RSS as a fraction of the limit, or null when there is no limit to compare
   *  against. */
  usedFraction: number | null;
}

export function sampleMemory(): MemorySample {
  const m = process.memoryUsage();
  const limitBytes = containerMemoryLimitBytes();
  return {
    rssBytes: m.rss,
    heapUsedBytes: m.heapUsed,
    heapTotalBytes: m.heapTotal,
    externalBytes: m.external,
    limitBytes,
    usedFraction: limitBytes ? m.rss / limitBytes : null,
  };
}

export function isMemoryPressured(sample: MemorySample): boolean {
  return sample.usedFraction !== null && sample.usedFraction >= MEMORY_WARN_FRACTION;
}

/** Megabytes, rounded. Logs are read by people, and 1673527296 is not a number
 *  anybody compares at a glance. */
function mb(bytes: number): number {
  return Math.round(bytes / 1024 / 1024);
}

export function logMemorySample(sample: MemorySample = sampleMemory()): void {
  // Written out at each call site rather than spread from one object: the log
  // rule requires a literal `event`, and it is right to — a computed event name
  // is a log line nobody can reliably search for.
  const rssMb = mb(sample.rssBytes);
  const heapUsedMb = mb(sample.heapUsedBytes);
  const heapTotalMb = mb(sample.heapTotalBytes);
  const externalMb = mb(sample.externalBytes);
  const limitMb = sample.limitBytes ? mb(sample.limitBytes) : null;
  const usedPct = sample.usedFraction === null ? null : Math.round(sample.usedFraction * 100);

  if (isMemoryPressured(sample)) {
    scrubLogger.warn({
      event: 'runtime_memory',
      rss_mb: rssMb,
      heap_used_mb: heapUsedMb,
      heap_total_mb: heapTotalMb,
      external_mb: externalMb,
      limit_mb: limitMb,
      used_pct: usedPct,
      message: 'memory is close to the container limit; a kill here leaves no other record',
    });
    return;
  }
  scrubLogger.info({
    event: 'runtime_memory',
    rss_mb: rssMb,
    heap_used_mb: heapUsedMb,
    heap_total_mb: heapTotalMb,
    external_mb: externalMb,
    limit_mb: limitMb,
    used_pct: usedPct,
  });
}

/**
 * Start the periodic sample.
 *
 * `unref()` matters: without it this timer is a live handle and the process
 * will not exit on its own, which turns a clean shutdown into a SIGKILL after
 * the grace period. Idempotent, so a second call during a re-init does not end
 * up with two timers writing two lines a minute.
 */
export function startMemoryMonitor(): void {
  if (timer) return;
  // One line immediately, so a process that dies inside its first minute still
  // left a record of where it started.
  logMemorySample();
  timer = setInterval(logMemorySample, MEMORY_SAMPLE_INTERVAL_MS);
  timer.unref();
}

export function stopMemoryMonitor(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

/** For tests — the module-level cache would otherwise carry one test's fake
 *  limit into the next. */
export function _resetMemoryMonitorForTesting(): void {
  stopMemoryMonitor();
  cachedLimitBytes = undefined;
}
