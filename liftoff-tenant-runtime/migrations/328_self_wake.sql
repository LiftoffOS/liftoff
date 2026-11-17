-- 328_self_wake.sql
--
-- Self-wake: agent-initiated suspend/resume (sleep_until, wake_on_event/job/poll, wake_on_any/all).
-- Numbered 328 because 327_hitl_approval_thread_link.sql already exists.
--
-- Additive + idempotent. NO RLS: agent_scheduled_invocations (224) and reactive_subscriptions (226)
-- are non-RLS, accessed via the scheduled-execution service pool with explicit tenant_id filters;
-- the new wake tables match that posture. No FK into RLS tables; the ASI<->subscription link is by
-- plain id (no cyclic FK); the reconciler owns orphan cleanup.

-- ── agent_scheduled_invocations: add settlement_pending; reuse existing resume_inflight (235) ──
-- resume_inflight was ALREADY added by migration 235; add ONLY settlement_pending, keeping every
-- existing value. Real constraint name (agent_scheduled_invocations_status_check).
ALTER TABLE agent_scheduled_invocations
  DROP CONSTRAINT IF EXISTS agent_scheduled_invocations_status_check;
ALTER TABLE agent_scheduled_invocations
  ADD CONSTRAINT agent_scheduled_invocations_status_check
  CHECK (status IN ('pending', 'resume_inflight', 'settlement_pending', 'fired', 'cancelled', 'errored'));

ALTER TABLE agent_scheduled_invocations
  ADD COLUMN IF NOT EXISTS wake_kind         TEXT
    CHECK (wake_kind IS NULL OR wake_kind IN ('timer', 'event', 'job', 'poll')),
  ADD COLUMN IF NOT EXISTS wake_spec         JSONB,
  ADD COLUMN IF NOT EXISTS wake_spec_version INT NOT NULL DEFAULT 1,
  -- Optional denormalization: the durable result cache of record is the event_processing_ledger
  -- (completed -> replay); wake_result is a cheap read for the settlement step.
  ADD COLUMN IF NOT EXISTS wake_result       JSONB,
  ADD COLUMN IF NOT EXISTS origin_trust      TEXT
    CHECK (origin_trust IS NULL OR origin_trust IN ('trusted', 'untrusted_inbound')),
  -- PB-supplied chat-message cursor for the native-resume staleness gate.
  ADD COLUMN IF NOT EXISTS thread_revision   BIGINT,
  -- Self-wake lineage: increments across ALL wake kinds (event/job included); only a standing
  -- reactive subscription resets. Distinct from chain_depth (schedule_followup fresh-run depth).
  ADD COLUMN IF NOT EXISTS wake_chain_depth  INT NOT NULL DEFAULT 0,
  -- Fenced heartbeat lease (mirrors execution-environments/agent-lock.ts): a stale worker whose
  -- lease was reclaimed can never overwrite the new owner (every transition is WHERE lease_token=$t).
  ADD COLUMN IF NOT EXISTS lease_token       UUID,
  ADD COLUMN IF NOT EXISTS lease_until       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lease_heartbeat_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resume_attempts   INT NOT NULL DEFAULT 0,
  -- Poll tick counter: distinct from resume_attempts (which counts every fenced claim incl.
  -- retryable-failure re-claims). Bounded by wake_spec.maxAttempts; exhaustion -> condition_expired.
  ADD COLUMN IF NOT EXISTS wake_poll_attempts INT NOT NULL DEFAULT 0,
  -- The one-shot reactive_subscriptions row this wake armed (for cancel/cleanup). Plain id, no FK.
  ADD COLUMN IF NOT EXISTS bound_subscription_id UUID,
  -- When set, this wake is a MEMBER of a wake_wait_sets row: firing it routes to the wait-set decision
  -- (any → resume the set + cancel siblings; all → resume once all members fired) instead of resuming
  -- the agent directly. NULL for a standalone wake. Plain id, no FK.
  ADD COLUMN IF NOT EXISTS wait_set_id       UUID,
  ADD COLUMN IF NOT EXISTS origin_surface    TEXT
    CHECK (origin_surface IS NULL OR origin_surface IN ('web', 'slack', 'teams', 'mcp'));  -- NULL = autonomous

-- One pending wake per (tenant, agent, context_ref) enforced at the DB, not just app-level replace.
CREATE UNIQUE INDEX IF NOT EXISTS idx_asi_one_pending_wake
  ON agent_scheduled_invocations (tenant_id, agent_id, context_ref)
  WHERE status IN ('pending', 'resume_inflight', 'settlement_pending') AND wake_kind IS NOT NULL;

-- Reconciler scan for stale leases (resume_inflight / settlement_pending past lease_until).
CREATE INDEX IF NOT EXISTS idx_asi_stale_lease
  ON agent_scheduled_invocations (lease_until)
  WHERE status IN ('resume_inflight', 'settlement_pending');

-- ── wake_resume_rate: durable per-(tenant,agent) fixed-window resume-rate counter ──
-- A runaway self-wake loop (or a herd of event/poll resumes) is throttled by a DURABLE counter (not an
-- in-memory one): each resume bumps the window count; over the configurable limit the resume DEFERS
-- (lease released → Cloud Task retry / TTL-expiry backstop re-drives) rather than being lost. This is a
-- runaway-protection throttle, NOT a usage/cost cap. No RLS (service-pool + explicit tenant_id).
CREATE TABLE IF NOT EXISTS wake_resume_rate (
  tenant_id    UUID NOT NULL,
  agent_id     UUID NOT NULL,
  window_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  count        INT NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, agent_id)
);

-- ── reactive_subscriptions: one-shot binding for wake_on_event ──
-- Lease is a COLUMN (claimed_until), NOT a status value — the status CHECK stays active|paused|errored.
ALTER TABLE reactive_subscriptions
  ADD COLUMN IF NOT EXISTS one_shot                     BOOLEAN NOT NULL DEFAULT FALSE,
  -- The ASI wake row to resume when this one-shot fires (renamed for clarity). Plain id, no FK.
  ADD COLUMN IF NOT EXISTS bound_scheduled_invocation_id UUID,
  ADD COLUMN IF NOT EXISTS claimed_until TIMESTAMPTZ, -- outbox delivery lease
  ADD COLUMN IF NOT EXISTS consumed_at                  TIMESTAMPTZ;   -- set ONLY after enqueue ACK

CREATE INDEX IF NOT EXISTS idx_rs_oneshot_live
  ON reactive_subscriptions (bound_scheduled_invocation_id)
  WHERE one_shot AND consumed_at IS NULL;

-- ── wake_event_delivery: durable delivery outbox ──
-- The router STAGES a row on match; a drain worker claims <=N/tick, creates a deterministic Cloud
-- Task, and only then marks the subscription consumed. Exactly-once per (wake, source_event).
CREATE TABLE IF NOT EXISTS wake_event_delivery (
  id                           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                    UUID NOT NULL,
  wake_scheduled_invocation_id UUID NOT NULL,          -- the ASI wake row to resume
  source_event_id              TEXT NOT NULL,           -- durable event identity (dedup)
  payload_ref                  JSONB NOT NULL,          -- bounded minimized snapshot OR a durable ref
  state                        TEXT NOT NULL DEFAULT 'staged'
    CHECK (state IN ('staged', 'enqueued', 'done', 'dead')),
  available_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_token                  UUID,
  lease_until                  TIMESTAMPTZ,
  attempts                     INT NOT NULL DEFAULT 0,
  cloud_task_name              TEXT,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (wake_scheduled_invocation_id, source_event_id)   -- exactly-once per (wake, event)
);

-- Drain-worker scan: claimable staged rows whose available_at has passed.
CREATE INDEX IF NOT EXISTS idx_wed_claimable
  ON wake_event_delivery (available_at)
  WHERE state = 'staged';
-- Reconciler scan: stale enqueue leases.
CREATE INDEX IF NOT EXISTS idx_wed_stale_lease
  ON wake_event_delivery (lease_until)
  WHERE state = 'enqueued';

COMMENT ON TABLE wake_event_delivery IS
  'Durable outbox for wake_on_event: router stages, drain worker enqueues <=N/tick then marks the one-shot subscription consumed.';

-- ── wake_wait_sets: wake_on_any / wake_on_all parent (waits on N member conditions) ──
-- A wait-set parent tracks a set of member wakes (ordinary agent_scheduled_invocations rows carrying
-- wait_set_id). 'any' resumes on the FIRST member that fires (siblings cancelled); 'all' resumes once
-- EVERY member has fired. The parent carries its own fenced heartbeat lease + execution/settlement
-- split, mirroring agent_scheduled_invocations, so the resume is exactly-once under redelivery.
-- No RLS (service-pool + explicit tenant_id); no FK into RLS tables; the reconciler owns orphan cleanup.
CREATE TABLE IF NOT EXISTS wake_wait_sets (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL,
  agent_id                UUID NOT NULL,
  mode                    TEXT NOT NULL CHECK (mode IN ('any', 'all')),
  status                  TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'resume_inflight', 'settlement_pending', 'fired', 'cancelled', 'errored')),
  fires_at                TIMESTAMPTZ NOT NULL,          -- TTL/expiry backstop for the whole set
  thread_id               UUID,
  origin_trust            TEXT CHECK (origin_trust IS NULL OR origin_trust IN ('trusted', 'untrusted_inbound')),
  origin_surface          TEXT CHECK (origin_surface IS NULL OR origin_surface IN ('web', 'slack', 'teams', 'mcp')),
  thread_revision         BIGINT,
  wake_chain_depth        INT NOT NULL DEFAULT 0,
  context_ref             TEXT NOT NULL,
  scheduled_by_invocation_id UUID,
  workflow_resume_payload JSONB,
  wake_result             JSONB,
  member_total            INT NOT NULL DEFAULT 0,        -- how many members the set was armed with
  lease_token             UUID,
  lease_until             TIMESTAMPTZ,
  lease_heartbeat_at      TIMESTAMPTZ,
  resume_attempts         INT NOT NULL DEFAULT 0,
  cloud_task_name         TEXT,
  fired_at                TIMESTAMPTZ,
  cancelled_at            TIMESTAMPTZ,
  last_error              TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One live wait-set per (tenant, agent, context_ref).
CREATE UNIQUE INDEX IF NOT EXISTS idx_wws_one_pending
  ON wake_wait_sets (tenant_id, agent_id, context_ref)
  WHERE status IN ('pending', 'resume_inflight', 'settlement_pending');
-- Reconciler scan for stale wait-set leases.
CREATE INDEX IF NOT EXISTS idx_wws_stale_lease
  ON wake_wait_sets (lease_until)
  WHERE status IN ('resume_inflight', 'settlement_pending');
-- Member lookup (count fired vs pending; cancel siblings).
CREATE INDEX IF NOT EXISTS idx_asi_wait_set
  ON agent_scheduled_invocations (wait_set_id)
  WHERE wait_set_id IS NOT NULL;

COMMENT ON TABLE wake_wait_sets IS
  'wake_on_any / wake_on_all parent: waits on N member wakes (agent_scheduled_invocations rows with wait_set_id). any=first member; all=every member. Own fenced lease + settlement split.';
