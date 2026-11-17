-- Migration 261: Persist retrieval query text on memory_retrieval_events.
--
-- The offline eval harness (src/scripts/memory-eval/) replays historical
-- retrievals against alternate ranker configurations. It needs the
-- verbatim query that was passed to retrieveMemories — currently lost
-- after the row is inserted. Rows pre-261 stay NULL; the harness
-- filters them out.
--
-- ALTER TABLE on a HASH-partitioned table cascades to all partitions
-- automatically in PostgreSQL 15.

ALTER TABLE memory_retrieval_events ADD COLUMN query_text TEXT;

COMMENT ON COLUMN memory_retrieval_events.query_text IS
  'Verbatim query passed to retrieveMemories. Truncated at 4000 chars. Rows from before this column existed have NULL.';
