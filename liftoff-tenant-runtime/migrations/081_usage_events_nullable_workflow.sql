-- Migration 081: Make workflow_id nullable on usage_events
--
-- Memory operations (embedding_generation, memory_save, memory_retrieve)
-- have no workflow context. The original NOT NULL constraint blocks these
-- events from being recorded in the usage ledger.

ALTER TABLE usage_events ALTER COLUMN workflow_id DROP NOT NULL;
