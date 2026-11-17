-- 431: a request for the person to take the browser over, and the task carries on.
--
-- An assistant driving the pane reaches a step it cannot do: a sign-in, a
-- one-time code, a payment detail, a check only a person can pass, anything
-- it is not allowed to type. Until now the only tool it had was to stop and
-- say so, and on the Stagehand vendors nothing could even ask. This table is
-- the request: one row per ask, one PENDING per session at a time
-- (browser_interventions_pending), made by the assistant's
-- ask_person_to_take_over_browser_session tool or the RequestIntervention
-- RPC, ANSWERED by the person's next takeover (startTakeover stamps the hold
-- that answered it, on the transaction's own client), CANCELLED by a
-- withdraw, by the session closing or by a takeover ending with the request
-- unanswered, and EXPIRED fifteen minutes after it was made when nobody took
-- over.
--
-- While a request is pending the assistant may read the browser and not act
-- in it: navigate, run a task, act on a control and a task's initial
-- navigation are refused with the request's own sentence, in the tool gate
-- and in the Goto, RunBrowserTask and ActOnPage RPCs. The reason is the
-- assistant's words to the model and travels model-only on the wire: the
-- person reads it in the assistant's own guarded reply, never from this row.
-- It is bounded and passed through the browser text sanitizer before it
-- lands, and the two flags say what that pass changed.
--
-- Retention: a request cascades from its session, so tenant deletion removes
-- these rows through web_sessions; the hold reference is set null when a hold
-- goes, because the request happened whether or not its answer is still
-- recorded.

CREATE TABLE browser_interventions (
  id                             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                      UUID NOT NULL,
  session_id                     UUID NOT NULL REFERENCES web_sessions(id) ON DELETE CASCADE,
  thread_id                      UUID,
  requested_by_invocation_id     TEXT,
  reason                         TEXT NOT NULL,
  reason_truncated               BOOLEAN NOT NULL DEFAULT FALSE,
  reason_protected_data_omitted  BOOLEAN NOT NULL DEFAULT FALSE,
  -- Millisecond precision, as the holds and the activity rows have: the
  -- value travels through a JavaScript Date on the wire.
  requested_at                   TIMESTAMPTZ(3) NOT NULL DEFAULT NOW(),
  status                         TEXT NOT NULL DEFAULT 'pending'
                                   CHECK (status IN ('pending', 'answered', 'cancelled', 'expired')),
  -- The hold that answered it; inline REFERENCES on a new table needs no
  -- initial check, so the FORCEd holds table is safe to reference here.
  hold_id                        UUID REFERENCES browser_takeover_holds(id) ON DELETE SET NULL,
  answered_at                    TIMESTAMPTZ(3),
  ended_at                       TIMESTAMPTZ(3),
  CONSTRAINT browser_interventions_answered_has_hold
    CHECK (status <> 'answered' OR hold_id IS NOT NULL)
);
CREATE UNIQUE INDEX browser_interventions_pending ON browser_interventions (session_id) WHERE status = 'pending';
CREATE INDEX browser_interventions_session ON browser_interventions (session_id, requested_at DESC);
CREATE INDEX browser_interventions_hold ON browser_interventions (hold_id);

-- Tenant policy as migration 423 writes it, FORCEd so the owning role is
-- bound by it too; every query runs under withTenantScope.
ALTER TABLE browser_interventions ENABLE ROW LEVEL SECURITY;
ALTER TABLE browser_interventions FORCE ROW LEVEL SECURITY;
CREATE POLICY browser_interventions_tenant ON browser_interventions
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

COMMENT ON TABLE browser_interventions IS
  'A request for the person to take the browser over and hand it back: one pending per session at a time. Answered by the next takeover (hold_id), cancelled by a withdraw, the session closing or an unanswered takeover ending, expired after fifteen minutes. While pending, the assistant reads the browser and does not act in it. The reason is model-only; the person reads it in the assistant''s reply.';
COMMENT ON COLUMN browser_interventions.reason IS
  'What the person needs to do and where, in the assistant''s words, bounded and through the browser text sanitizer. Never shown to a person from this row.';
COMMENT ON COLUMN browser_interventions.hold_id IS
  'The takeover hold that answered this request; null while pending or when the request ended unanswered.';
