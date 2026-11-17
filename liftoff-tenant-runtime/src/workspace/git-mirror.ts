/**
 * R5 Fix 6: Per-tenant git mirror cache.
 *
 * Mirror path: /var/cache/mirrors/<tenantId>/<owner>--<repo>.git
 * Lock via mirror_locks row (30 min TTL, 5 min heartbeat w/ AbortController —
 * R5 BE-R5-004: lock loss aborts fetch).
 *
 * Safety hardening (R3/R4/R5):
 *   - GIT_CONFIG_NOSYSTEM=1, GIT_CONFIG_GLOBAL=/dev/null, GIT_LFS_SKIP_SMUDGE=1
 *   - GIT_ALLOW_PROTOCOL=https
 *   - --no-recurse-submodules + submodule.recurse=false (R5 SE-R5-010)
 *   - Pre-clone size check via GitHub API (max 2 GB)
 *   - Atomic hook-strip (move+rm inside lock window)
 *   - Embedded credentials in URL rejected (R4 SE-R4-004)
 */
import crypto from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { Pool } from 'pg';
import { scrubLogger } from '../observability/scrub-logger';
import { buildSafeGitEnv, validateOwnerRepo, validateGitCloneTarget, assertNoSubmoduleArgs } from '../tool-gateway/workspace-tools-mcp';

const execFileP = promisify(execFile);

const MIRROR_ROOT = '/var/cache/mirrors';
const MAX_REPO_SIZE_KB = 2_000_000; // 2 GB

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function resolveMirrorPath(tenantId: string, owner: string, repo: string): string {
  if (!UUID_RE.test(tenantId)) throw new Error(`invalid tenantId: ${tenantId}`);
  validateOwnerRepo(owner, repo);
  const safe = `${owner}--${repo}.git`;
  const full = path.join(MIRROR_ROOT, tenantId, safe);
  const canonical = path.resolve(full);
  if (!canonical.startsWith(MIRROR_ROOT + path.sep)) {
    throw new Error('mirror path escapes root');
  }
  return canonical;
}

export interface MirrorLock {
  held: boolean;
  abortController: AbortController;
  heartbeatTask: ReturnType<typeof setTimeout> | null;
  invocationId: string;
}

async function gitRun(
  args: string[],
  cwd?: string,
  abortSignal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  // R5 SE-R5-010: defense-in-depth rejection of submodule-enabling args
  assertNoSubmoduleArgs(args);
  return execFileP('git', args, {
    cwd,
    env: buildSafeGitEnv(),
    timeout: 600_000,
    maxBuffer: 4 * 1024 * 1024,
    signal: abortSignal,
  });
}

export interface MirrorDeps {
  pool: Pool;
  fetchRepoSizeKB: (owner: string, repo: string) => Promise<number>;
}

async function tryAcquireMirrorLock(
  pool: Pool,
  tenantId: string,
  owner: string,
  repo: string,
): Promise<MirrorLock> {
  const invocationId = crypto.randomUUID();
  try {
    await pool.query(
      `DELETE FROM mirror_locks WHERE tenant_id = $1 AND owner = $2 AND repo = $3 AND expires_at <= NOW()`,
      [tenantId, owner, repo],
    );
    const result = await pool.query(
      `INSERT INTO mirror_locks (tenant_id, owner, repo, acquired_by_invocation_id, expires_at)
       VALUES ($1, $2, $3, $4, NOW() + INTERVAL '30 minutes')
       ON CONFLICT (tenant_id, owner, repo) DO NOTHING
       RETURNING 1`,
      [tenantId, owner, repo, invocationId],
    );
    if ((result.rowCount ?? 0) === 0) {
      return { held: false, abortController: new AbortController(), heartbeatTask: null, invocationId };
    }
  } catch (err) {
    scrubLogger.warn({ event: 'mirror_init_failed', tenantId, owner, repo, err: (err as Error).message });
    return { held: false, abortController: new AbortController(), heartbeatTask: null, invocationId };
  }

  const lock: MirrorLock = {
    held: true,
    abortController: new AbortController(),
    heartbeatTask: null,
    invocationId,
  };

  const schedule = (): void => {
    lock.heartbeatTask = setTimeout(async () => {
      try {
        const result = await pool.query(
          `UPDATE mirror_locks
           SET expires_at = NOW() + INTERVAL '30 minutes'
           WHERE tenant_id = $1 AND owner = $2 AND repo = $3 AND acquired_by_invocation_id = $4
           RETURNING 1`,
          [tenantId, owner, repo, invocationId],
        );
        if ((result.rowCount ?? 0) === 0) {
          // R5 BE-R5-004: abort mirror operation on lock loss
          scrubLogger.error({ event: 'mirror_lock_lost', tenantId, owner, repo });
          lock.abortController.abort(new Error('Mirror lock lost'));
          return;
        }
      } catch {
        // transient DB failure; continue and retry next tick
      }
      schedule();
    }, 5 * 60 * 1000 + (Math.random() * 30_000 - 15_000));
  };
  schedule();

  return lock;
}

async function releaseMirrorLock(pool: Pool, tenantId: string, owner: string, repo: string, lock: MirrorLock): Promise<void> {
  if (lock.heartbeatTask) clearTimeout(lock.heartbeatTask);
  if (!lock.held) return;
  try {
    await pool.query(
      `DELETE FROM mirror_locks
       WHERE tenant_id = $1 AND owner = $2 AND repo = $3 AND acquired_by_invocation_id = $4`,
      [tenantId, owner, repo, lock.invocationId],
    );
  } catch {
    // lock row will expire naturally
  }
}

async function stripHooksAtomic(mirrorPath: string): Promise<void> {
  const hooksDir = path.join(mirrorPath, 'hooks');
  const pendingRemoval = `${hooksDir}.removing.${crypto.randomUUID()}`;
  try {
    await fs.rename(hooksDir, pendingRemoval);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    return;
  }
  await fs.rm(pendingRemoval, { recursive: true, force: true });
  // Read-only empty hooks dir to prevent recreation in normal git operations
  await fs.mkdir(hooksDir, { mode: 0o500 });
}

async function populateFreshMirror(
  owner: string,
  repo: string,
  mirrorPath: string,
  abortSignal: AbortSignal,
): Promise<void> {
  await fs.mkdir(path.dirname(mirrorPath), { recursive: true, mode: 0o700 });
  const url = validateGitCloneTarget(owner, repo);
  await gitRun(
    [
      'clone',
      '--mirror',
      '--no-local',
      '--no-recurse-submodules', // R5 SE-R5-010
      '-c',
      'submodule.recurse=false',
      url,
      mirrorPath,
    ],
    undefined,
    abortSignal,
  );
  await stripHooksAtomic(mirrorPath);
  const hooksStat = await fs.stat(path.join(mirrorPath, 'hooks')).catch(() => null);
  if (!hooksStat) {
    throw new Error('Hook dir missing after strip — invariant violated');
  }
}

export async function ensureMirror(
  deps: MirrorDeps,
  tenantId: string,
  owner: string,
  repo: string,
): Promise<string | null> {
  validateOwnerRepo(owner, repo);
  const mirrorPath = resolveMirrorPath(tenantId, owner, repo);
  const lock = await tryAcquireMirrorLock(deps.pool, tenantId, owner, repo);
  if (!lock.held) return null;

  try {
    const exists = await fs
      .stat(mirrorPath)
      .then(() => true)
      .catch(() => false);

    if (exists) {
      const headOk = await fs
        .stat(path.join(mirrorPath, 'HEAD'))
        .then(() => true)
        .catch(() => false);
      if (!headOk) {
        await fs.rm(mirrorPath, { recursive: true, force: true });
        const sizeKB = await deps.fetchRepoSizeKB(owner, repo);
        if (sizeKB > MAX_REPO_SIZE_KB) {
          throw new Error(`Repo too large: ${sizeKB}KB > ${MAX_REPO_SIZE_KB}KB`);
        }
        await populateFreshMirror(owner, repo, mirrorPath, lock.abortController.signal);
      } else {
        try {
          await gitRun(
            [
              'fetch',
              '--all',
              '--prune',
              '--no-recurse-submodules', // R5 SE-R5-010
            ],
            mirrorPath,
            lock.abortController.signal,
          );
        } catch (err) {
          scrubLogger.warn({ event: 'mirror_fetch_failed', owner, repo, err: (err as Error).message });
        }
        await stripHooksAtomic(mirrorPath);
      }
    } else {
      const sizeKB = await deps.fetchRepoSizeKB(owner, repo);
      if (sizeKB > MAX_REPO_SIZE_KB) {
        throw new Error(`Repo too large: ${sizeKB}KB > ${MAX_REPO_SIZE_KB}KB`);
      }
      await populateFreshMirror(owner, repo, mirrorPath, lock.abortController.signal);
    }

    return mirrorPath;
  } catch (err) {
    scrubLogger.error({
      event: 'mirror_init_failed',
      owner,
      repo,
      tenantId,
      err: (err as Error).message,
    });
    return null;
  } finally {
    await releaseMirrorLock(deps.pool, tenantId, owner, repo, lock);
  }
}
