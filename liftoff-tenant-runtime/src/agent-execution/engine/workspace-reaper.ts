/**
 * Workspace reaper.
 *
 * Two distinct responsibilities, merged into one module per R5 plan:
 *   1. `reapStaleWorkspaces()` — legacy autonomous-mode `/tmp/invocations`
 *      cleanup (mtime-based). Preserved signature for existing callers.
 *   2. `reapStaleChatWorkspaces(opts, deps)` — R5 chat-thread
 *      `/tmp/chat-threads/<tenantId>/<threadId>/` cleanup with DB-backed
 *      tombstone TOCTOU guard.
 *
 * R5 additions for the chat reaper:
 *   - R4 TE-ADD-003: a LIVE workspace is skipped. Live means something is
 *     heartbeating the thread's turn lock right now, read through
 *     src/interactive-chat/turn-lock-registry.ts — not merely that a lock row's
 *     lease has not run out, which is what this used to ask and which a
 *     container that died mid-turn satisfies for a further twenty minutes
 *     (INV-PB-018)
 *   - R5 BE-R5-001: tombstone 60s TTL + statement_timeout release on dedicated
 *     connection bounds thread outage under pool saturation
 *   - R5 TE-R5-004: injectable onBeforeRm hook for deterministic tests
 */
import crypto from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import type { Pool } from 'pg';
import {
  acquireTombstone,
  deleteDeadLock,
  lockIsLiveForUpdate,
  releaseLock,
} from '../../interactive-chat/turn-lock-registry';
import { logger } from '../../infrastructure/logging';

// ============================================================================
// Legacy autonomous /tmp/invocations reaper (preserved signature)
// ============================================================================

const INVOCATIONS_ROOT = '/tmp/invocations';
const MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

export async function reapStaleWorkspaces(): Promise<number> {
  try {
    const entries = await fs.readdir(INVOCATIONS_ROOT).catch(() => []);
    const now = Date.now();
    let reaped = 0;
    for (const entry of entries) {
      const dir = path.join(INVOCATIONS_ROOT, entry);
      try {
        const stat = await fs.stat(dir);
        if (stat.isDirectory() && now - stat.mtimeMs > MAX_AGE_MS) {
          await fs.rm(dir, { recursive: true, force: true });
          reaped++;
        }
      } catch {
        // skip entries we can't stat
      }
    }
    if (reaped > 0) {
      logger.info({ reaped, root: INVOCATIONS_ROOT }, 'workspace-reaper: cleaned up stale invocation dirs');
    }
    return reaped;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'workspace-reaper: scan failed');
    return 0;
  }
}

// ============================================================================
// R5 chat-thread /tmp/chat-threads reaper (tombstone TOCTOU guard)
// ============================================================================

export const CHAT_WORKSPACE_ROOT = '/tmp/chat-threads';
const TOMBSTONE_TTL_SECONDS = 60;
const RELEASE_STATEMENT_TIMEOUT_MS = 5000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ReapStaleChatOptions {
  maxDurationMs: number;
  /** R5 TE-R5-004: test-only injection. Production never sets this. */
  onBeforeRm?: () => Promise<void>;
  /** Optional override for workspace root (tests). */
  workspaceRoot?: string;
}

export interface ChatSweepResult {
  evicted: number;
  skippedLive: number;
  remaining: number;
}

export interface ChatReaperDeps {
  pool: Pool;
  logger: {
    info: (f: Record<string, unknown>) => void;
    warn: (f: Record<string, unknown>) => void;
    error: (f: Record<string, unknown>) => void;
  };
}

export function parseChatWorkspacePath(
  wsPath: string,
  root = CHAT_WORKSPACE_ROOT,
): { tenantId: string; threadId: string } {
  const rel = path.relative(root, wsPath);
  const parts = rel.split(path.sep);
  if (parts.length < 2 || !UUID_RE.test(parts[0]) || !UUID_RE.test(parts[1])) {
    throw new Error(`not a valid chat workspace path: ${wsPath}`);
  }
  return { tenantId: parts[0], threadId: parts[1] };
}

export async function listCandidateChatWorkspaces(root = CHAT_WORKSPACE_ROOT): Promise<string[]> {
  try {
    const tenants = await fs.readdir(root, { withFileTypes: true });
    const out: string[] = [];
    for (const t of tenants) {
      if (!t.isDirectory() || !UUID_RE.test(t.name)) continue;
      const tenantDir = path.join(root, t.name);
      try {
        const threads = await fs.readdir(tenantDir, { withFileTypes: true });
        for (const th of threads) {
          if (!th.isDirectory() || !UUID_RE.test(th.name)) continue;
          out.push(path.join(tenantDir, th.name));
        }
      } catch {
        // tenant dir removed concurrently — skip
      }
    }
    return out;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw err;
  }
}

export async function reapStaleChatWorkspaces(
  opts: ReapStaleChatOptions,
  deps: ChatReaperDeps,
): Promise<ChatSweepResult> {
  const { pool, logger: l } = deps;
  const start = Date.now();
  const root = opts.workspaceRoot ?? CHAT_WORKSPACE_ROOT;
  let evicted = 0;
  let skippedLive = 0;

  const candidates = await listCandidateChatWorkspaces(root);
  let processed = 0;

  for (const wsPath of candidates) {
    if (Date.now() - start > opts.maxDurationMs) {
      break;
    }

    let tenantId: string;
    let threadId: string;
    try {
      ({ tenantId, threadId } = parseChatWorkspacePath(wsPath, root));
    } catch {
      continue;
    }

    const reaperInvocation = crypto.randomUUID();
    const client = await pool.connect();
    let ownsTombstone = false;
    try {
      // The read and the tombstone write stay in ONE transaction: that is the
      // TOCTOU guard this sweep exists to have, and it is why every registry
      // function takes a caller's client. A call that opened its own connection
      // would leave two sweeps able to both decide a workspace was free.
      await client.query('BEGIN');
      if (await lockIsLiveForUpdate(client, tenantId, threadId)) {
        await client.query('ROLLBACK');
        skippedLive++;
        processed++;
        continue;
      }
      await deleteDeadLock(pool, tenantId, threadId, client);
      const tombstone = await acquireTombstone(
        pool, tenantId, threadId, reaperInvocation, TOMBSTONE_TTL_SECONDS, client,
      );
      if (tombstone === 'held') {
        await client.query('ROLLBACK');
        skippedLive++;
        processed++;
        continue;
      }
      await client.query('COMMIT');
      ownsTombstone = true;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // swallow
      }
      l.warn({
        event: 'reaper_tombstone_tx_failed',
        tenantId,
        threadId,
        err: (err as Error).message,
      });
      processed++;
      continue;
    } finally {
      client.release();
    }

    try {
      if (opts.onBeforeRm) {
        await opts.onBeforeRm();
      }
      await fs.rm(wsPath, { recursive: true, force: true });
      evicted++;
    } catch (err) {
      l.warn({ event: 'reaper_rm_failed', wsPath, err: (err as Error).message });
    } finally {
      if (ownsTombstone) {
        const directClient = await pool.connect();
        try {
          await directClient.query(`SET statement_timeout = ${RELEASE_STATEMENT_TIMEOUT_MS}`);
          // On this client, not the pool: the statement_timeout above is a
          // SESSION setting, so the release has to run on the connection that
          // carries it. That bound is what stops a saturated pool turning a
          // tombstone into a thread outage (R5 BE-R5-001).
          await releaseLock(pool, tenantId, threadId, reaperInvocation, directClient);
        } catch (err) {
          l.error({
            event: 'reaper_tombstone_release_failed',
            tenantId,
            threadId,
            err: (err as Error).message,
          });
        } finally {
          directClient.release();
        }
      }
    }
    processed++;
  }

  const remaining = Math.max(0, candidates.length - processed);
  l.info({
    event: 'reaper_sweep_complete',
    evicted,
    skippedLive,
    remaining,
    durationMs: Date.now() - start,
  });
  return { evicted, skippedLive, remaining };
}
