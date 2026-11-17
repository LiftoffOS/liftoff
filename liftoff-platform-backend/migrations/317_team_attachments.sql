-- Team-scoped build-time attachments.
-- Imported files on the team-build / team-update pages become attachments on the
-- internal agent — NOT knowledge items. Stored as a TeamAttachment[] JSONB:
--   { kind:'upload',    name, content, addedAt, source }
--   { kind:'connector', name, connectorId, connectorType, externalId, sourceUrl?, addedAt, source }
-- They feed distillation (upload content inline; connector refs resolved at
-- distill time via the knowledge extraction machinery) and are returned on
-- agent reads so the UI can rehydrate attachment cards.
ALTER TABLE internal_agents
  ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Snapshotted per version (same rationale as skills in migration 252): a
-- rollback restores the build inputs that produced that version's prompts.
ALTER TABLE internal_agent_versions
  ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb;
