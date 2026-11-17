-- 507: the effect class beside the categories (1b).
--
-- The governance engine trusts a DECLARED read class over its name heuristic,
-- and tools from custom MCP servers and external agents reach it with none:
-- without one, read tools such as enrich_company or verify_email are gated on
-- every call.
-- The classifier now asks one more Choice, `effect`, in the same request as
-- the five sensitivity categories, and stores the confident answer here.
-- Named by the classifier's INSERT and SELECT (mcp/tool-classifier.ts) and
-- read back by the custom-MCP raw-tools endpoint and the external-agent
-- config endpoint, which carry it to the runtime.
--
-- NULL changes nothing downstream. Applied seed migrations are not edited;
-- seed rows stay NULL until a rediscovery re-classifies them.
--
-- classification_version is the questions.ts integer that wrote the row, so
-- a row older than the current version is re-classified on the next
-- discovery instead of kept forever on a matching description hash.

ALTER TABLE tool_classification_cache
  ADD COLUMN IF NOT EXISTS effect_class TEXT
    CHECK (effect_class IN ('read', 'write', 'destructive', 'outbound')),
  ADD COLUMN IF NOT EXISTS classification_version INTEGER;

COMMENT ON COLUMN tool_classification_cache.effect_class IS
  'What one call does, in connector-service''s vocabulary, when the classifier answered confidently. NULL: no confident answer, or a row written before the effect head existed.';
COMMENT ON COLUMN tool_classification_cache.classification_version IS
  'The classifier question-set version (src/typesafe/questions.ts CLASSIFICATION_VERSION) that produced this row. NULL on seed rows and rows from the generation path; a row older than the current version is re-classified on the next discovery.';
