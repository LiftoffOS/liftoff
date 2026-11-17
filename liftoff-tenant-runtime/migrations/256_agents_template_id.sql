-- Persist the template_id (slug like 'customer-support-representative') of
-- the agent template the internal agent was provisioned from. Required for
-- the citation-warning hook to identify support-template agents at PostToolUse
-- time without a network round-trip to platform-backend.

ALTER TABLE agents ADD COLUMN template_id TEXT;
