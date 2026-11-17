-- Migration 161: Add instructions column to internal_agents for codex-agent-sdk engine
-- Plain-text instructions document used by Codex (OpenAI Agents SDK) agents.
-- instructionsMd remains for claude-agent-sdk agents; exactly one should be non-null per agent.
-- Also adds instructions column to internal_agent_versions for snapshot tracking.

ALTER TABLE internal_agents
  ADD COLUMN IF NOT EXISTS instructions TEXT;

ALTER TABLE internal_agent_versions
  ADD COLUMN IF NOT EXISTS instructions TEXT;
