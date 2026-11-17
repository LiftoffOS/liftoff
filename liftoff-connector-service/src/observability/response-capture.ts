// Phase 4 — capture the first real vendor response per (native connector, read function) as a
// fixture seed. These are the only real payloads we ever see for these HRIS providers (no test
// accounts). Fire-and-forget, never throws; ONE sample per action (first-write-wins); PII redacted
// before write. scripts/pull-response-samples.ts turns the samples into committed fixtures that
// then flow through the Phase 1B contract gate + Phase 2 drift checker.
import { redactPii } from '@liftoffos/proto-gen/dist/redaction.js';
import { getAdminPool } from '../db/pool.js';
import { unwrapVendorBody } from './response-conformance.js';
import { logger } from '../infra/logging.js';

const WRITE_CATS = new Set(['write', 'destructive', 'outbound']);
/** A read is anything that is NOT a write/destructive/outbound tool (mirrors the drift/gate
 *  read semantics — captures multi-category reads like ['read','sensitive'], never mutations). */
function isReadOnly(fn: { categories: readonly string[] }): boolean {
  return fn.categories.length > 0 && !fn.categories.some((c) => WRITE_CATS.has(c));
}

function deepRedact(v: unknown): unknown {
  if (typeof v === 'string') return redactPii(v);
  if (Array.isArray(v)) return v.map(deepRedact);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) o[k] = deepRedact(val);
    return o;
  }
  return v;
}

// Per-process short-circuit: once we've recorded a sample for an action this process, skip the DB
// round-trip entirely (the row is first-write-wins, so repeat INSERTs are pure waste). Resets on
// restart — worst case one INSERT per action per process, which ON CONFLICT DO NOTHING absorbs.
const captured = new Set<string>();
export function _resetCaptured(): void { captured.clear(); } // test-only

/**
 * Record one redacted sample of a native-HRIS READ response. Fire-and-forget — callers `void` it
 * and never await; never throws. `fn` is the already-resolved ConnectorFunction (dispatcher passes
 * it — no duplicate registry lookup). The dispatcher has already confirmed native-serving.
 */
export async function captureResponseSample(
  connectorType: string,
  functionName: string,
  fn: { categories: readonly string[] } | undefined,
  result: unknown,
): Promise<void> {
  if (!fn || !isReadOnly(fn)) return; // reads only
  const key = `${connectorType} ${functionName}`;
  if (captured.has(key)) return; // already captured this process
  try {
    const pool = await getAdminPool();
    await pool.query(
      `INSERT INTO connector_response_samples (connector_type, function_name, sample)
         VALUES ($1, $2, $3) ON CONFLICT (connector_type, function_name) DO NOTHING`,
      // Store the RAW vendor body (unwrap the adapter's { id, data } read envelope), so the
      // captured fixture speaks the same shape as the codegen responseSchema + the Phase 1B gate.
      [connectorType, functionName, JSON.stringify(deepRedact(unwrapVendorBody(result)))],
    );
    captured.add(key);
  } catch (err) {
    logger.warn({ connectorType, functionName, err: (err as Error).message }, 'response_sample_capture_failed');
  }
}
