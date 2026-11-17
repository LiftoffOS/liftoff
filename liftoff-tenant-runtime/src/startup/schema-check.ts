/**
 * R5 BE-R5-006: Non-blocking schema version readiness probe.
 *
 * R4 used fail-fast startup throw — which breaks rolling deploys when the
 * migration job hasn't finished before new Cloud Run instances boot. R5
 * polls schema_version in the background; readiness probe returns 503 until
 * the expected version is present.
 */
import type { Pool } from 'pg';
import { scrubLogger } from '../observability/scrub-logger';

export const EXPECTED_SCHEMA_VERSION = 5;

let schemaReady = false;

export function isSchemaReady(): boolean {
  return schemaReady;
}

async function schemaVersionOk(pool: Pool): Promise<boolean> {
  try {
    const result = await pool.query<{ version: number }>(
      `SELECT version FROM schema_version WHERE component = 'chat_turn_runtime'`,
    );
    return result.rows[0]?.version === EXPECTED_SCHEMA_VERSION;
  } catch {
    return false;
  }
}

export async function pollSchemaUntilReady(
  pool: Pool,
  opts: { maxAttempts?: number; intervalMs?: number } = {},
): Promise<void> {
  const maxAttempts = opts.maxAttempts ?? 60;
  const intervalMs = opts.intervalMs ?? 5000;
  let attempts = 0;
  while (!(await schemaVersionOk(pool))) {
    attempts++;
    if (attempts >= maxAttempts) {
      scrubLogger.error({ event: 'schema_check_timeout', attempts });
      return; // stay not-ready; Cloud Run will recycle the instance
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  schemaReady = true;
  scrubLogger.info({ event: 'schema_check_ready', attempts });
}

/**
 * Is the database reachable and the schema still the one we expect, right now?
 *
 * `isSchemaReady()` above latches at boot and never looks again, which is
 * correct for a STARTUP probe — it answers "did this instance finish coming
 * up". It is the wrong answer for a liveness-adjacent readiness probe, because
 * an instance whose database has gone away, or whose schema was rolled back
 * underneath it, keeps reporting ready and keeps taking traffic it cannot
 * serve. This asks the question again.
 *
 * Strictly read-only, and bounded twice over: a short statement timeout so a
 * struggling database cannot hold the probe open, and a result cached for a few
 * seconds so probe traffic — which arrives on a schedule, from every instance —
 * cannot become load of its own.
 */
const PROBE_CACHE_MS = Number(process.env.READINESS_PROBE_CACHE_MS ?? 5_000);
const PROBE_TIMEOUT_MS = Number(process.env.READINESS_PROBE_TIMEOUT_MS ?? 2_000);

export interface SchemaProbe {
  dbReachable: boolean;
  schemaCurrent: boolean;
  /** Present only when the probe failed, so the reason is in the response
   *  rather than only in a log somebody has to go and find. */
  error?: string;
  checkedAt: string;
}

let cachedProbe: { at: number; value: SchemaProbe } | null = null;
let inFlight: Promise<SchemaProbe> | null = null;

export async function probeSchema(pool: Pool): Promise<SchemaProbe> {
  const now = Date.now();
  if (cachedProbe && now - cachedProbe.at < PROBE_CACHE_MS) return cachedProbe.value;
  // Collapse concurrent probes onto one query. Cloud Run can deliver several
  // health checks at once, and three identical round trips answer nothing that
  // one does.
  if (inFlight) return inFlight;

  inFlight = (async (): Promise<SchemaProbe> => {
    const client = await pool.connect();
    try {
      // Per-transaction so it cannot leak onto a pooled connection that is
      // later used for real work.
      await client.query('BEGIN READ ONLY');
      await client.query(`SET LOCAL statement_timeout = ${PROBE_TIMEOUT_MS}`);
      const res = await client.query<{ version: number }>(
        `SELECT version FROM schema_version WHERE component = 'chat_turn_runtime'`,
      );
      await client.query('COMMIT');
      return {
        dbReachable: true,
        schemaCurrent: res.rows[0]?.version === EXPECTED_SCHEMA_VERSION,
        checkedAt: new Date().toISOString(),
      };
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* connection is already gone */ }
      return {
        dbReachable: false,
        schemaCurrent: false,
        error: (err as Error).message,
        checkedAt: new Date().toISOString(),
      };
    } finally {
      client.release();
    }
  })();

  try {
    const value = await inFlight;
    cachedProbe = { at: Date.now(), value };
    return value;
  } finally {
    inFlight = null;
  }
}

/** For tests only. */
export function _resetSchemaReadyForTesting(): void {
  schemaReady = false;
  cachedProbe = null;
  inFlight = null;
}
