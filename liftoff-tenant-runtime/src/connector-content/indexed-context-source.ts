// Indexed connector content as a search source.
//
// `connector_content` is a hybrid BM25 + HNSW index that the content indexer
// populates from every read tool call — PII-redacted, embedded and TTL'd. Its
// only readers were external MCP clients coming through the control plane, so
// agents re-fetched, one call at a time, data the platform had already indexed
// and paid to embed. This is the seam that lets an agent read it.
//
// TWO PROPERTIES ARE LOAD-BEARING:
//
//   1. It never throws. This is an additive source inside a tool whose other
//      sources must still return. A failure here costs one source, never the
//      whole search.
//   2. It always states its coverage, including on the empty path. The index
//      holds only what has already been fetched, so "no results" NEVER means
//      "does not exist at the source". A retrieval surface that cannot say
//      that produces confident false negatives — the retrieval form of a
//      fabricated success.

import { logger } from '../infrastructure/logging';
import {
  connectorContentCoverage,
  searchConnectorContent,
  type SearchCoverage,
  type SearchResult,
} from './search-service';

export interface IndexedContextResult {
  items: SearchResult[];
  coverage: SearchCoverage;
  /** Present when the caller must qualify what an empty or partial result
   *  means. Written for a model to repeat, not for a log. */
  note?: string;
  /** False when this source did not actually run — it failed, or the run's cap
   *  refused it.
   *
   *  Separate from `items.length === 0` because the two mean different things
   *  and the audit row has to say which: "searched, found nothing" and "never
   *  searched" look identical on /activity otherwise, and the second one
   *  reported as a success is a fabricated one. */
  ok: boolean;
  /** Why it did not run. Absent when `ok` is true. */
  error?: string;
}

/** Upper bound on items returned per call, so one source cannot crowd the
 *  other two out of the model's context window. */
const MAX_LIMIT = 25;
const DEFAULT_LIMIT = 5;

/**
 * Per-run ceiling on indexed searches.
 *
 * The control plane rate-limits this same search at 30/min for external MCP
 * clients. Agents have no equivalent — standard tools do not pass through
 * admission — so a looping agent could spend unbounded HyDE calls. This is a
 * placeholder to be set from observed distribution, not a calibrated number.
 */
const MAX_SEARCHES_PER_RUN = Number.parseInt(
  process.env.INDEXED_CONTEXT_MAX_SEARCHES_PER_RUN ?? '20',
  10,
);

/** Bound on the counter map itself. A runtime serves one tenant but many runs;
 *  without this the map grows for the life of the pod. */
const MAX_TRACKED_RUNS = 500;

/** How long a counter outlives its last use.
 *
 *  A cap with no expiry is a cap that only ever tightens. Runs end, and a
 *  counter that never resets turns a per-run ceiling into a permanent one —
 *  the feature switches itself off and nothing says so. Comfortably longer
 *  than any run, short enough that a pod does not accumulate. */
const COUNTER_TTL_MS = 60 * 60 * 1000;

const searchesByRun = new Map<string, { used: number; expiresAt: number }>();

/** True when this run may perform another indexed search. Counts on the way
 *  through, so the caller cannot forget to. */
function claimSearchSlot(runKey: string): boolean {
  const now = Date.now();

  const existing = searchesByRun.get(runKey);
  if (existing && existing.expiresAt <= now) searchesByRun.delete(runKey);

  const entry = searchesByRun.get(runKey);
  const used = entry?.used ?? 0;
  if (used >= MAX_SEARCHES_PER_RUN) return false;

  if (!entry && searchesByRun.size >= MAX_TRACKED_RUNS) {
    // Drop what has already expired before evicting anything live.
    for (const [key, value] of searchesByRun) {
      if (value.expiresAt <= now) searchesByRun.delete(key);
    }
    if (searchesByRun.size >= MAX_TRACKED_RUNS) {
      // Insertion-ordered: the oldest key is the first one Map yields.
      const oldest = searchesByRun.keys().next();
      if (!oldest.done) searchesByRun.delete(oldest.value);
    }
  }

  searchesByRun.set(runKey, { used: used + 1, expiresAt: now + COUNTER_TTL_MS });
  return true;
}

const EMPTY_COVERAGE: SearchCoverage = {
  indexedItems: 0,
  oldestIndexedAt: null,
  newestIndexedAt: null,
};

/** What a model should say instead of asserting absence. */
function coverageNote(coverage: SearchCoverage): string {
  if (coverage.indexedItems === 0) {
    return (
      'Nothing has been indexed for this workspace yet. This source only holds content ' +
      'already fetched by previous tool calls, so an empty result here says nothing about ' +
      'whether the data exists in the connected system. Query the connector directly.'
    );
  }
  const from = coverage.oldestIndexedAt ? coverage.oldestIndexedAt.slice(0, 10) : 'an unknown date';
  return (
    `No match among the ${coverage.indexedItems} items indexed so far (from ${from} onward). ` +
    'This source only holds content already fetched by previous tool calls, so absence here ' +
    'is not absence at the source.'
  );
}

/**
 * Search already-indexed connector content.
 *
 * Costs nothing at the vendor and does not touch the Composio quota — the
 * content was paid for when it was first fetched.
 */
export async function searchIndexedContext(args: {
  tenantId: string;
  agentId: string;
  query: string;
  /** Restrict to specific connector types. Empty or absent searches all of
   *  them. More than one type runs one query per type, so the caller's own
   *  connector list bounds the fan-out. */
  connectorTypes?: string[];
  limit?: number;
  /** A retrieval vector the caller already built, so this source does not buy
   *  a second hypothetical document for the same query. */
  embeddingJson?: string;
  /** The caller already tried to build a vector and the provider was down.
   *  Search lexically rather than trying again — one outage should not become
   *  one failed provider call per source. */
  semanticUnavailable?: boolean;
  /** Identifies the run for the per-run search ceiling.
   *
   *  REQUIRED, and deliberately not defaulted to the tenant id. A tenant-wide
   *  key is shared by every run forever, so the twentieth search would cap that
   *  tenant permanently rather than capping one run — the feature would switch
   *  itself off silently. Callers pass the invocation id, or the trace id when
   *  there is no invocation; both are per-run. */
  runKey: string;
}): Promise<IndexedContextResult> {
  const query = args.query?.trim() ?? '';
  if (!query) {
    return { items: [], coverage: EMPTY_COVERAGE, ok: false, error: 'empty_query', note: 'No query supplied.' };
  }

  const limit = Math.min(MAX_LIMIT, Math.max(1, args.limit ?? DEFAULT_LIMIT));
  const runKey = args.runKey;

  if (!claimSearchSlot(runKey)) {
    logger.info(
      { tenantId: args.tenantId, agentId: args.agentId, runKey, cap: MAX_SEARCHES_PER_RUN },
      'indexed_context_run_cap_reached',
    );
    return {
      items: [],
      coverage: EMPTY_COVERAGE,
      ok: false,
      error: 'run_cap_reached',
      note:
        `This run has reached its limit of ${MAX_SEARCHES_PER_RUN} searches over already-indexed ` +
        'content. Use the connector tools directly for anything still missing.',
    };
  }

  try {
    const types = (args.connectorTypes ?? []).filter(Boolean);

    const [results, coverage] = await Promise.all([
      types.length > 0
        ? Promise.all(
            types.map((connectorType) =>
              searchConnectorContent({
                tenantId: args.tenantId,
                query,
                connectorType,
                limit,
                agentId: args.agentId,
                // `search` runs memory as its own source. Letting an empty
                // index fall back to memories here would return the same rows
                // twice under two labels, with a coverage object reporting
                // zero indexed items beside them.
                coldStartFallback: false,
                ...(args.semanticUnavailable ? { lexicalOnly: true } : {}),
                ...(args.embeddingJson ? { embeddingJson: args.embeddingJson } : {}),
              }),
            ),
          ).then((perType) => perType.flat())
        : searchConnectorContent({
            tenantId: args.tenantId,
            query,
            limit,
            agentId: args.agentId,
            coldStartFallback: false,
            ...(args.semanticUnavailable ? { lexicalOnly: true } : {}),
            ...(args.embeddingJson ? { embeddingJson: args.embeddingJson } : {}),
          }),
      connectorContentCoverage(args.tenantId),
    ]);

    // Highest score first, then truncate: a per-type fan-out returns `limit`
    // from each and the caller asked for `limit` overall.
    const items = [...results].sort((a, b) => b.score - a.score).slice(0, limit);

    return {
      items,
      coverage,
      ok: true,
      ...(items.length === 0 ? { note: coverageNote(coverage) } : {}),
    };
  } catch (err) {
    // Zero items and a stated reason. The alternative — letting this throw —
    // would take memory and the live connector dispatch down with it.
    logger.warn(
      {
        err: (err as Error).message,
        tenantId: args.tenantId,
        agentId: args.agentId,
      },
      'indexed_context_search_failed',
    );
    return {
      items: [],
      coverage: EMPTY_COVERAGE,
      ok: false,
      error: (err as Error).message,
      note:
        'Previously-indexed content could not be searched for this request, so it was skipped. ' +
        'Nothing can be concluded from its absence here.',
    };
  }
}

/** Test helper — clears per-run search counters. NOT for prod use. */
export function _resetIndexedContextCountersForTesting(): void {
  searchesByRun.clear();
}
