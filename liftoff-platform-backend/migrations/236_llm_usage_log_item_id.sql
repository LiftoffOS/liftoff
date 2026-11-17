-- Phase 2.1: per-item attribution for knowledge embeddings.
-- Tagged onto every llm_usage_log row written by the knowledge embedding
-- batch worker so platform-admin queries can rank tenants' largest-cost
-- items (e.g. a 50-page SOP that gets re-embedded on every edit). NULL for
-- LLM completions and for query-time embedding rows (they have agent_id
-- but no item_id).

ALTER TABLE llm_usage_log ADD COLUMN item_id UUID;

CREATE INDEX llm_usage_log_item_id_idx
  ON llm_usage_log (item_id)
  WHERE item_id IS NOT NULL;

-- Mirror onto the downstream cost-attribution ledger so platform-admin
-- queries can rank tenants' largest-cost items end-to-end. The
-- platform-llm-ingester passes this through from llm_usage_log.
ALTER TABLE cost_attribution_events ADD COLUMN item_id UUID;

CREATE INDEX cost_attribution_events_item_id_idx
  ON cost_attribution_events (item_id)
  WHERE item_id IS NOT NULL;
