// Memory System Types
// Per implementation plan: Phase 2 Memory System

import type { DbTransaction } from '../infrastructure/database';

// Memory layer determines scope of access.
// 'conversation' is thread-scoped: scope_key is forced to threadId server-side,
// memories are only retrieved within the originating thread, and auto-expire in 7 days.
export type MemoryLayer = 'global' | 'role' | 'individual' | 'conversation';

// Content classification for PII handling
export type ContentClassification = 'public' | 'internal' | 'pii' | 'sensitive';

// Provenance graph types
export type NodeType =
  | 'connector_event'
  | 'agent_action'
  | 'system_event'
  | 'hitl_event'
  | 'chat_feedback'
  | 'memory'
  | 'instruction_amendment';

export type EdgeType = 'produced' | 'synthesized_into' | 'contributed_to';

export interface SourceEventInput {
  nodeType: NodeType;
  refId: string;
  connectorId?: string | null;
  agentId?: string | null;
  confidence?: number;
  metadata?: Record<string, unknown>;
}

// Memory record
export interface Memory {
  id: string;
  tenantId: string;
  layer: MemoryLayer;
  scopeKey: string;
  agentId: string | null;
  workflowId: string | null;
  content: string;
  contentHash: string;
  embedding: number[] | null;
  embeddingModel: string;
  tags: string[];
  contentClassification: ContentClassification;
  expiresAt: Date | null;
  supersededBy: string | null;
  supersededAt: Date | null;
  supersessionReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  usefulnessScore: number;
  lastUsedAt: Date | null;
  usageCount: number;  // default 1, incremented on semantic dedup
}

export interface DedupScopeHint {
  /** Match only memories whose scope_key starts with this string. */
  scopeKeyPrefix?: string;
  /** Require at least one of these tags on the candidate. */
  requireTags?: string[];
}

export interface SaveMemoryResult {
  memoryId: string;
  deduplicated: boolean;
  usageCount?: number;  // present only on dedup-match path
}

// Options for saving memory
export interface SaveMemoryOptions {
  tenantId: string;
  layer: MemoryLayer;
  scopeKey: string;
  content: string;
  contentClassification?: ContentClassification;
  agentId?: string;
  workflowId?: string;
  tags?: string[];
  expiresAt?: Date;
  semanticDedup?: boolean; // If true, increment usage_count when >0.9 similar memory exists
  dedupScopeHint?: DedupScopeHint;
  threadId?: string;       // Required when layer === 'conversation'; service enforces scope_key = threadId
  source?: SourceEventInput;
  tx?: DbTransaction;
  /** Set at INSERT: a NULL `retrievable_after` is RETRIEVABLE at every read
   *  site, so applying a quarantine in a later UPDATE leaves the row exposed
   *  until that statement lands, and forever if it fails. */
  retrievableAfter?: Date;
  /** Omitted means DEFAULT_MEMORY_IMPORTANCE_SCORE. */
  importanceScore?: number;
}

/** Mirrors `memories.importance_score SMALLINT NOT NULL DEFAULT 3` (migration
 *  072). The column rejects a null, so the insert supplies this rather than
 *  letting the parameter carry one; keep the two in step. */
export const DEFAULT_MEMORY_IMPORTANCE_SCORE = 3;

// Options for retrieving memories
export interface RetrieveMemoryOptions {
  tenantId: string;
  query: string;
  agentId?: string;
  layers?: MemoryLayer[];
  scopeKeys?: string[];
  topK?: number;
  minSimilarity?: number;
  tags?: string[];
  contextTags?: string[];  // Tags for re-ranking tag boost
  threadId?: string;       // When present, also fetches conversation-layer memories for this thread
  invocationId?: string;   // Change B: ties retrieval to citation (memory_retrieval_events row)
  includePeerLearning?: boolean; // Change A: when defaults narrow, opt into peer-window pull
  /** A retrieval vector the caller already built. When present, the semantic
   *  arm uses it instead of writing its own hypothetical document and
   *  embedding it.
   *
   *  Note what this DOES NOT skip: alias decoding still expands the query, and
   *  the expanded text still drives the BM25 arm. Only the vector is shared. */
  precomputedQueryEmbedding?: number[];
  /** The caller already tried to build a vector and the embedding provider was
   *  unreachable. Go straight to the recency fallback instead of making a
   *  second call that will fail the same way — the outcome is identical and
   *  one failed provider call per retrieval source, per search, is not. */
  semanticRetrievalUnavailable?: boolean;
}

// Retrieved memory with similarity score
export interface RetrievedMemory {
  id: string;
  content: string;
  layer: MemoryLayer;
  scopeKey: string;
  similarity: number;        // raw cosine similarity
  compositeScore?: number;   // after re-ranking (for debugging/logging)
  tags: string[];
  createdAt: Date;
  source?: 'semantic' | 'top-usefulness' | 'conversation' | 'peer-learning';
  agentId?: string;    // UUID of the agent that wrote this memory
  agentName?: string;  // agents.name (may be absent for harvest/system writes)
  summaryLevel?: number; // Change C: 0 = raw, 1 = daily L1, 2 = weekly L2
  influenceScore?: number; // Change B: cited/retrieved Laplace-smoothed
  sourceTrust?: number;    // Change D: provenance-derived [0, 1]
}

// Options for superseding a memory
export interface SupersedeMemoryOptions {
  memoryId: string;
  /** The successor's content, when this call creates the successor. */
  newContent?: string;
  /** An existing row as the successor: the memory is retired under it and
   *  no new row is written. The admission check (memory-admit.ts) retires
   *  a neighbour under the row it just saved this way. */
  successorId?: string;
  reason?: string;
}

// Validation error
export class MemoryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryValidationError';
  }
}

// Content limits
export const MAX_CONTENT_LENGTH = 100 * 1024; // 100KB
export const MAX_TAGS = 20;
export const SCOPE_KEY_PATTERN = /^[a-zA-Z0-9_-]+$/;
// Tags are agent-supplied identifiers. Common use cases include email
// addresses (e.g. `someone@example.com`), Slack handles (`@someone`),
// thread IDs, customer IDs, ARNs, URLs, etc. The earlier `_:./-` set
// rejected `@` and `+`, which silently broke a primary agent use case
// (tagging memories by sender email) and produced confusing validation
// errors during normal operation. Email-safe character set: includes
// `@` and `+`. Still excludes whitespace, quotes, angle brackets, and
// other punctuation that would create injection surfaces.
export const TAG_PATTERN = /^[a-zA-Z0-9_+@:./-]+$/;
