-- Proposed routines a team member offers, and the person accepts or declines
-- in conversation (P1.3).
--
-- The product shape this supports: a team member that shows initiative the way
-- a good new hire does — "now that HubSpot is connected, I could review new
-- deals each weekday morning and stay quiet on days with nothing to report.
-- Would you like me to?" — rather than a dashboard of suggestions nobody opens.
--
-- Two invariants live in this table:
--
--  * Nothing is ever auto-created. A row here is a PROPOSAL; the routine only
--    exists after the person says yes, and then it is authored the same way
--    every other routine is (prose appended to the team member's guidance, then
--    distilled). This table never becomes a second job engine.
--
--  * A decline is remembered. `dedup_key` is unique per agent, so a proposal
--    that was turned down is never offered again — the difference between a
--    colleague who takes an answer and one who keeps asking.

CREATE TABLE agent_suggestions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id),
  agent_id          UUID NOT NULL REFERENCES internal_agents(id) ON DELETE CASCADE,
  -- Stable identity for "this same idea", so declining latches permanently
  -- even though the wording is regenerated each time.
  dedup_key         TEXT NOT NULL,
  -- integration: a connector was bound to this team member.
  -- usage:       the same request recurred often enough to be worth automating.
  -- chat:        the person described a schedule while talking to it.
  source            TEXT NOT NULL CHECK (source IN ('integration', 'usage', 'chat')),
  -- What the team member says when it offers this.
  proposal_text     TEXT NOT NULL,
  -- The routine in prose, appended to the team member's guidance on accept.
  -- Never a cron expression: routines are distilled from prose, never authored
  -- directly, so this is the input to distillation rather than a schedule.
  routine_prose     TEXT NOT NULL,
  -- Why it was offered, shown as provenance ("suggested because you connected
  -- HubSpot"). Free-form and small.
  provenance_note   TEXT,
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'accepted', 'dismissed', 'cooldown')),
  -- Which thread it was offered in, so the accept/decline check only runs where
  -- the question was actually asked.
  thread_id         UUID,
  offered_at        TIMESTAMPTZ,
  decided_at        TIMESTAMPTZ,
  -- 'not now' parks a proposal until this passes, rather than latching it.
  cooldown_until    TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One decision per idea per team member: this is what makes "no" stick.
CREATE UNIQUE INDEX idx_agent_suggestions_dedup
  ON agent_suggestions (agent_id, dedup_key);

-- The hot read: "does this team member have an open proposal right now?"
-- Answered on the accept/decline check of a chat turn, so it must be cheap.
CREATE INDEX idx_agent_suggestions_open
  ON agent_suggestions (agent_id, status)
  WHERE status = 'pending';

CREATE INDEX idx_agent_suggestions_tenant ON agent_suggestions (tenant_id);

ALTER TABLE agent_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_suggestions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_suggestions
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);
