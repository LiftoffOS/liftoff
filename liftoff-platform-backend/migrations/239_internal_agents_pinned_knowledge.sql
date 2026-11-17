-- Pinned knowledge items act as a retrieval bias for corpus_search.
-- Operators reference them via [[knowledge:id:title]] markers in the agent's
-- responsibilities or additionalContext fields; the router parses the markers
-- and writes the IDs here. Validation at save time guarantees every ID's
-- source connector is bound to the agent.

ALTER TABLE internal_agents
  ADD COLUMN pinned_knowledge_ids UUID[] NOT NULL DEFAULT '{}';

-- Version snapshots also carry the historical pin set so rollback / time-travel
-- UIs see the actual pins at that version, not a backfilled default-empty.
ALTER TABLE internal_agent_versions
  ADD COLUMN pinned_knowledge_ids UUID[] NOT NULL DEFAULT '{}';

-- Index supports the cascade-delete trigger below + future "find agents that
-- pin item X" admin queries. Use array_length predicate (not <> '{}') because
-- Postgres's GIN array operators (&&) don't always push <> predicates into
-- partial indexes -- array_length is more reliably plannable.
CREATE INDEX internal_agents_pinned_knowledge_ids_idx
  ON internal_agents USING GIN (pinned_knowledge_ids)
  WHERE array_length(pinned_knowledge_ids, 1) > 0;

-- Cascade-clean pin arrays when a knowledge_item is deleted. Without this
-- trigger, deleting an article from /dashboard/knowledge leaves dangling
-- UUIDs in every agent's pinned_knowledge_ids -- corpus_search silently
-- ignores them (no matching row, no promotion) but the array is corrupted.
-- The GIN index makes the && lookup cheap.
CREATE OR REPLACE FUNCTION cleanup_pinned_knowledge_on_delete()
RETURNS TRIGGER AS $$
BEGIN
  -- knowledge_items.tenant_id is TEXT (migration 183) but
  -- internal_agents.tenant_id is UUID (migration 016 ai_teams lineage).
  -- Cast explicitly so the cross-table predicate planner-friendly and
  -- avoids the implicit-coercion warning at trigger fire time.
  UPDATE internal_agents
     SET pinned_knowledge_ids = array_remove(pinned_knowledge_ids, OLD.id)
   WHERE tenant_id = OLD.tenant_id::uuid
     AND pinned_knowledge_ids && ARRAY[OLD.id];
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER cleanup_pinned_knowledge_on_delete_trg
  AFTER DELETE ON knowledge_items
  FOR EACH ROW
  EXECUTE FUNCTION cleanup_pinned_knowledge_on_delete();

-- One row per agent processed by the Phase 4 backfill job. Retained ~30 days
-- so operators can audit which tenants had orphan-pin issues before cleanup.
CREATE TABLE pinned_knowledge_backfill_report (
  agent_id              UUID PRIMARY KEY,
  tenant_id             TEXT NOT NULL,
  pins_backfilled       INTEGER NOT NULL,
  pins_dropped_invalid  INTEGER NOT NULL,
  system_prompt_stripped BOOLEAN NOT NULL,
  invalid_pin_details   JSONB,
  processed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
