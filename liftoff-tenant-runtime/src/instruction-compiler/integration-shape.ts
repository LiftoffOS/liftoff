// Canonical shape & normalization for the integration objects stored in
// `compiled_instructions.integrations` (JSONB).
//
// History: platform-backend has two write paths that disagree on the
// connector-type field name — distill-service.ts:1957 writes `type`, but
// distill-service.ts:1976 (and older paths / the React FE) write
// `integrationId`. The published `internal_agent.updated` event payload
// is typed as `{ id; type?; selectedObjects? }` in events/subscriber.ts,
// so when an older payload arrives with `integrationId` only, TR persists
// it verbatim and downstream consumers that read `i.type` see undefined.
// Every BYOK gate (mcp-server.ts:673 `allowedConnectors.includes('anchor_browser')`,
// expose-tools.ts byokAgent, binding-resolver.ts:81 `if (!i.type) continue`,
// tools-builder.ts:62, event-trigger.ts:245 `find(i => i.type === ...)`)
// is type-keyed, so a row written via the older path silently loses
// every BYOK web/browser tool and every connector-typed binding lookup
// — including run_browser_task, so the agent loses browser navigation.
//
// Every site that reads compiled_instructions.integrations MUST normalize
// through this helper. The integration shape is now type-keyed by
// construction, regardless of which PB write path produced the row.

/** Canonical shape after normalization. `type` is always populated when
 *  the source row carried either `type` or `integrationId`. */
export interface NormalizedIntegration {
  id: string;
  type?: string;
  selectedObjects?: string[];
  config?: Record<string, unknown>;
  // Other historical fields are preserved verbatim via spread; this list
  // is non-exhaustive.
  [extra: string]: unknown;
}

/** Raw shape as it can appear in compiled_instructions.integrations. */
interface RawIntegration {
  id?: string;
  type?: string;
  integrationId?: string;
  selectedObjects?: string[];
  config?: Record<string, unknown>;
  [extra: string]: unknown;
}

/** Normalize a single raw integration: prefer `type`, fall back to
 *  `integrationId`. Spreads other fields verbatim. */
export function normalizeIntegration(raw: RawIntegration): NormalizedIntegration {
  return {
    ...raw,
    id: String(raw.id ?? ''),
    type: raw.type ?? raw.integrationId,
  };
}

/** Parse + normalize the integrations column off a compiled_instructions
 *  row (`row.integrations` may be a JSONB array OR a JSON string,
 *  depending on the pg driver / column type). Returns [] for null / bad
 *  shapes — callers can safely chain .map / .filter. */
export function normalizeIntegrationsField(raw: unknown): NormalizedIntegration[] {
  if (raw == null) return [];
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  return (parsed as RawIntegration[]).map(normalizeIntegration);
}
