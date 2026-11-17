-- 428: which meaning of the Escalation and Communication settings a workspace
-- has chosen, carried on the runtime's cached copy of its oversight settings.
--
-- The control plane records, per setting whose meaning changes, whether the
-- workspace has saved that setting since the change (platform-backend
-- migration 505: `escalation_semantics`, `communication_semantics`; 1 = the
-- meaning the workspace chose under, 2 = the meaning the page states now).
-- The runtime reads them off this cache the way it reads the settings, and
-- an ABSENT value reads as 1: a row synced before this column existed, or
-- from a control plane that does not send it yet, keeps today's behaviour.
-- Nullable for exactly that reason; nothing is backfilled.
ALTER TABLE tenant_oversight_cache
  ADD COLUMN IF NOT EXISTS escalation_semantics SMALLINT,
  ADD COLUMN IF NOT EXISTS communication_semantics SMALLINT;

COMMENT ON COLUMN tenant_oversight_cache.escalation_semantics IS
  'Which meaning of the Escalation setting the workspace chose under (1 = before the surfacing policy, 2 = the page''s stated levels). NULL reads as 1.';
COMMENT ON COLUMN tenant_oversight_cache.communication_semantics IS
  'Which meaning of the Communication setting the workspace chose under (1 = before the message check, 2 = the page''s stated behaviour). NULL reads as 1.';
