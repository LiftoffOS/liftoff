# Tenant-Runtime Memory System

## Four storage layers
- `global`: tenant-wide.
- `role`: per-(tenant, role) shared across agents that play that role. The
  `scope_key` IS the role, as `roleScopeKey(agents.role)` — a slug, because
  the column allows `[a-zA-Z0-9_-]` only (`competitive-intelligence-analyst`).
  `memoryService.resolveRoleScopeKey` derives it, every reader filters role
  rows by it through one clause builder (`buildLayerScopeClause`), graduation
  groups by it and `learned_role_instructions` is read by it. A writer with no
  role to key by refuses rather than keying by the agent id, and a caller's
  `scope_key` on this layer becomes a `group:` tag, never the key.
- `individual`: per-agent (`agent_id`).
- `conversation`: per-thread; auto-expires in 7 days.

## Two summary tiers (Change C)
- `summary_level = 1`: daily L1 summaries of L0 memories grouped by primary tag.
- `summary_level = 2`: weekly L2 summaries of L1 memories grouped by topic.

L0 memories covered by an L1 summary for ≥30 days are superseded (still queryable
via provenance lineage). Same pattern L1 → L2 at 90 days.

## Per-(tenant, role) durable read path (Change A)
`learned_role_instructions` is the source of truth for graduated role-layer
content. Append-only `_history` preserves "what did role X know on date Y?".
Runtime injects `content_md` into the system prompt by joining `agents.role`
to the tenant row.

## Hybrid retrieval pipeline
HyDE → embedding → HNSW (oversample 50) + BM25 (tsvector) → RRF merge →
re-rank with composite score `(tag, semantic, recency, type, feedback, influence,
summary)` modulated by `source_trust`.

## Citation telemetry loop (Change B)
1. `retrieveMemories` writes a `memory_retrieval_events` row when `invocationId` is supplied.
2. Post-execution, `detectUsedMemories` returns the cited subset; the row's `cited_ids` is updated.
3. Daily `rollupYesterday` aggregates events into `memory_influence_rollup`.
4. `recomputeInfluenceScores` derives Laplace-smoothed `influence_score` from a 30-day window.
5. `scoreMemory` adds `+ W_INFLUENCE * influence_score` (positive boost only; no decay).

## Source-trust (Change D)
Per-memory `source_trust ∈ [0, 1]` derived from the originating provenance node:

| node_type | trust |
|---|---|
| chat_feedback | 1.00 |
| hitl_event | 0.90 |
| agent_action | 0.60 |
| system_event | 0.50 |
| connector_event | 0.40 |
| memory (synthesis lineage) | inherits max(parent trusts) |

`scoreMemory` multiplies the feedback term by `source_trust * W_SOURCE_TRUST`.

## Embedding cache (Change E)
Global `embedding_cache` keyed by `(content_hash, embedding_model)`. PII/sensitive
content never embeds, so the cache never holds sensitive material.

