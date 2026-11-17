-- Migration 378: an agent remembers which template it was hired from.
--
-- Nothing recorded it, so `redistill-service` could not pass `templateId` into
-- distillation, and everything gated on that id was dropped on every redistill:
-- the template seeding hint, the declared inputs, the destinations the person
-- picked, and the extraction column contract. A template-hired agent could
-- therefore never receive an improvement to the distill prompt — only a fresh
-- hire could — and redistilling one silently returned a weaker agent than the
-- one that was created.
--
-- `template_source_hash` is what makes reusing the id SAFE. It is taken over
-- the authored text at creation (responsibilities + additionalContext). On
-- redistill the hash is recomputed over the current row: unchanged means the
-- text is still the template's, so the id may be used; different means somebody
-- has edited the agent, it is theirs now rather than ours, and redistilling it
-- against our template would quietly pull their wording back toward ours.
--
-- Both are nullable by design. Agents built in TeamBuilder have no template,
-- and every agent that already exists predates this column: those redistill
-- exactly as they do today.

ALTER TABLE internal_agents
  ADD COLUMN IF NOT EXISTS template_id VARCHAR(200),
  ADD COLUMN IF NOT EXISTS template_source_hash VARCHAR(64);

COMMENT ON COLUMN internal_agents.template_id IS
  'The agent-template this agent was hired from, or NULL for one built by hand. Read on redistill, and only when template_source_hash still matches the authored text.';

COMMENT ON COLUMN internal_agents.template_source_hash IS
  'sha256 of responsibilities + additionalContext as the hire created them. A mismatch means the owner has edited the agent, so the template link is not used for redistillation.';
