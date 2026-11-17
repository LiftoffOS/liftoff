/**
 * R5 Fix 4: SIGTERM handler with 20s drain + fallback tuple cleanup.
 *
 * Cloud Run default grace is 10s; tenant-runtime terraform sets it to 30s.
 * SIGTERM drain waits 20s for in-flight turns to complete, then aborts
 * remaining AbortControllers and force-releases locks.
 *
 * R5 BE-R5-008: cleanup uses (tenantId, threadId, invocationId OR acquired_at
 * < 25 min ago) so a reaper-stolen tombstone is also cleared.
 */
import type { Pool } from 'pg';
import type { LockHandle } from './locks';
import { releaseLockOnDrain } from './turn-lock-registry';
import { scrubLogger } from '../observability/scrub-logger';

const DRAIN_DEADLINE_MS = 20_000; // R5 BE-R4-002: 20s (was 8s)

export class DrainController {
  private readonly inFlight = new Map<string, LockHandle>();
  private draining = false;
  private _ready = true;

  get isDraining(): boolean {
    return this.draining;
  }

  get startupReady(): boolean {
    return this._ready;
  }

  setReady(v: boolean): void {
    this._ready = v;
  }

  register(handle: LockHandle): void {
    this.inFlight.set(handle.invocationId, handle);
  }

  unregister(invocationId: string): void {
    this.inFlight.delete(invocationId);
  }

  inFlightCount(): number {
    return this.inFlight.size;
  }

  /** Call once at process startup. */
  install(pool: Pool): void {
    process.on('SIGTERM', async () => {
      this.draining = true;
      this._ready = false;
      scrubLogger.info({ event: 'sigterm_received', inFlight: this.inFlight.size });

      const deadline = Date.now() + DRAIN_DEADLINE_MS;
      while (this.inFlight.size > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }

      // Snapshot survivors before aborting (abort mutates external state)
      const remaining = Array.from(this.inFlight.values());

      for (const handle of remaining) {
        handle.abortController.abort(new Error('SIGTERM drain'));
        if (handle.heartbeatTask) {
          clearTimeout(handle.heartbeatTask);
          handle.heartbeatTask = null;
        }
      }

      for (const handle of remaining) {
        try {
          // R5 BE-R5-008: tuple + age-fallback DELETE covers reaper tombstone
          // case. The statement is the registry's (INV-PB-018) — this is the
          // ORDERLY exit, and the point of the invariant is that the disorderly
          // one costs a thread only ~75s rather than the whole lease.
          await releaseLockOnDrain(pool, handle.tenantId, handle.threadId, handle.invocationId);
        } catch (err) {
          scrubLogger.error({
            event: 'sigterm_release_failed',
            tenantId: handle.tenantId,
            threadId: handle.threadId,
            err: (err as Error).message,
          });
        }
      }

      process.exit(0);
    });
  }
}

export const drainController = new DrainController();
