-- Migration 328: per-AI-team AI vendor override
--
-- The workspace already picks one AI vendor for everything it runs
-- (migration 322 + `tenants.model_configs`). This column is the per-team
-- exception to that choice: a single team member can be pinned to a different
-- vendor without moving the workspace.
--
-- THREE states, not two. The distinction is load-bearing and the shipped
-- client depends on it:
--
--   NULL        inherit — follow the workspace, including future changes.
--   'default'   pinned to Liftoff Managed routing for this team, regardless of
--               what the workspace is set to. NOT a synonym for inherit: on a
--               workspace pinned to Anthropic, someone choosing "Liftoff
--               Managed" for one team means exactly this value.
--   <vendor>    pinned to that vendor.
--
-- So 'default' is in the CHECK list alongside the seven concrete vendors. The
-- eight values are the WorkspaceAiSelection union
-- (src/model-registry/workspace-ai-vendors.ts), which is in turn the React
-- WorkspaceAiVendor union (src/services/tenants.ts). Dropping 'default' here
-- would 400 a legitimate selection — and because the field rides the same PUT
-- as role/responsibilities/skills/attachments, it would fail the whole save.
--
-- Inherit is NULL rather than a sentinel string so the "no override" case
-- needs no reading code at all: every consumer already treats a null column as
-- absent.

ALTER TABLE internal_agents
  ADD COLUMN ai_vendor_override VARCHAR(20) NULL
    CHECK (ai_vendor_override IN (
      'default', 'anthropic', 'openai', 'google', 'deepseek', 'glm', 'kimi', 'qwen'
    ));

-- Version snapshots must capture ai_vendor_override so rollback restores it,
-- exactly as migration 167 did for autonomy_override (and 179 had to repair
-- when the versions half was forgotten).
ALTER TABLE internal_agent_versions
  ADD COLUMN ai_vendor_override VARCHAR(20) NULL
    CHECK (ai_vendor_override IN (
      'default', 'anthropic', 'openai', 'google', 'deepseek', 'glm', 'kimi', 'qwen'
    ));
