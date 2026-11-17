-- Add a source/routing discriminator to the clarification pause so different
-- pause origins (recovery LLM, Anchor intervention, future tool yields)
-- can resolve through the same /review queue while routing to the right backend.
--
-- The clarification rows are discriminated by `objective = 'clarification-expiry'`
-- (set by AgentExecutionService.createClarificationPause at service.ts:4896).
-- There is NO `pause_reason` column — `pauseReason` is a TypeScript field
-- inside the HybridResumeState serialized into workflow_resume_payload JSONB.

ALTER TABLE agent_scheduled_invocations
  ADD COLUMN clarification_source TEXT NULL
    CHECK (clarification_source IN ('recovery_llm', 'anchor_intervention')),
  ADD COLUMN vendor_request_id TEXT NULL;

-- Backfill: every existing clarification row was emitted by the recovery LLM
-- (Anchor intervention routing doesn't exist yet).
UPDATE agent_scheduled_invocations
  SET clarification_source = 'recovery_llm'
  WHERE objective = 'clarification-expiry';

-- Lock in: any clarification row going forward MUST carry a source. No silent
-- defaults at the DB layer, no fallback branches at the TS layer.
ALTER TABLE agent_scheduled_invocations
  ADD CONSTRAINT chk_clarification_source_required
  CHECK (
    objective != 'clarification-expiry'
    OR clarification_source IS NOT NULL
  );

-- Index for the queue listing UNION (filter pending clarifications fast).
CREATE INDEX idx_agent_scheduled_invocations_pending_clarification
  ON agent_scheduled_invocations (tenant_id, status, created_at DESC)
  WHERE objective = 'clarification-expiry' AND status = 'pending';
