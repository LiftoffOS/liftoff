// Capability discovery — shared types.
//
// The service answers ONE question: for a structured capability need, which
// named building blocks (connector functions, native tools, external
// automations) fit best right now. Retrieval is LIVE against the sources per
// query — no catalog is mirrored, because catalogs drift and stats are only
// trustworthy at query time. Persistence is limited to our own artifacts
// (blueprints, usage evidence) and a short-TTL query cache.

export type CapabilityMode = 'own_account' | 'public_data';

/** Structured spec — consumers derive this; the service never takes free text.
 *  A free-text query cannot be checked: the judge scores candidates against
 *  the fields here (what inputs the workflow will hold, what output fields the
 *  deliverable needs), which is what makes a verdict falsifiable. */
export interface CapabilitySpec {
  /** 'instagram', 'zillow', … lowercase, no spaces. Absent = cross-system. */
  targetSystem?: string;
  /** Verb phrase: 'search posts', 'enrich person'. */
  operation: string;
  /** 'posts', 'profiles', 'listings'. */
  entity: string;
  mode: CapabilityMode;
  /** What the workflow will actually hold when this step runs. */
  availableInputs: string[];
  /** Fields the deliverable needs from this step's output. */
  requiredOutputFields: string[];
  /** For evidence lookup + logging; NOT a filter on sources. */
  tenantId: string;
  /** The agent's/assistant's current bindings, for route preference. */
  boundConnectorTypes: string[];
}

export type CandidateSource = 'apify_store' | 'connector_registry' | 'native_tool';

export interface Candidate {
  source: CandidateSource;
  /** Stable ref: apify 'username/name'; registry '<connectorType>:<functionName>';
   *  native tool name. */
  sourceRef: string;
  title: string;
  description: string;
  mode: CapabilityMode;
  inputSchema?: unknown;
  outputSchema?: unknown;
  /** What one call costs the customer's Operating Units, as best known
   *  before running: a platform-funded function's listed price; a store
   *  actor's per-item price at a typical result count, or the compute
   *  estimate for one with no price of its own (`estimated`); ZERO for a
   *  bound connector, because the workspace pays that vendor directly and
   *  no Operating Units are drawn for the vendor part. */
  price?: { type: 'PER_CALL' | 'PER_RESULT' | 'OTHER'; usd: number; estimated?: boolean } | null;
  stats?: { rating?: number; users30d?: number; lastRunAt?: string } | null;
  /** Set for connector_registry candidates so route preference can tell a
   *  bound connector from an unbound one. */
  connectorType?: string;
  /** Curated capability bucket id (capability-tree.ts), when the connector
   *  classifies into one — the vendor-agnostic label the assistant surface
   *  shows instead of the vendor. Absent for unclassified candidates. */
  capabilityBucket?: string;
  /** Cheap query-relevance score (Stage-2 pre-rank). Ranks the candidate for
   *  truncation before the judge, is a first-class factor in the final score,
   *  and is the ranking signal the scorer falls back to when the judge degrades
   *  — so a judge timeout can no longer let a query-blind prior bury the
   *  relevant candidates. 0 = no lexical overlap. */
  relevance?: number;
}

export interface JudgeVerdict {
  capabilityMatch: 0 | 1 | 2 | 3;
  inputSupplyable: 'yes' | 'partial' | 'no';
  outputCovers: 'yes' | 'partial' | 'no';
  shapeMatch: boolean;
  /** One sentence; persisted with the result for calibration review. */
  reason: string;
}

export type CandidateRoute =
  | 'bound_connector'
  | 'native_tool'
  | 'platform_vendor'
  | 'blueprint';

export interface ScoredCandidate extends Candidate {
  judge: JudgeVerdict;
  route: CandidateRoute;
  evidence: { successes: number; failures: number } | null;
  /** Blueprint procedure for this sourceRef when one exists — our authored
   *  text, safe to render (still fenced at the distill boundary). */
  blueprintProcedureMd?: string;
  finalScore: number;
}

export interface DiscoveryResult {
  spec: CapabilitySpec;
  /** Ranked descending by finalScore, post-filter. */
  candidates: ScoredCandidate[];
  /** A source timed out or the judge failed — the list may be incomplete. */
  degraded: boolean;
}
