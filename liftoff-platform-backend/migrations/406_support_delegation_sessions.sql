-- Migration 406: support delegation sessions ("become user").
--
-- A platform admin needs to see and operate a customer's workspace as that
-- customer, both to reproduce per-user bugs and to finish setup on their
-- behalf. The mechanism is DELEGATION, not impersonation (RFC 8693): the
-- admin's own Firebase credential is never swapped. One middleware rewrites the
-- EFFECTIVE identity for the life of a request while the actor stays recorded
-- alongside it, so nothing downstream loses track of which human acted.
--
-- Why a table rather than a header the client asserts. Authorising on
-- `accounts.is_platform_admin` alone would make this a standing ambient
-- capability: anyone holding an admin's Firebase token, or any XSS in an
-- admin's browser, would get silent write access to every customer workspace,
-- with no revocation short of demoting the admin. A row makes each session a
-- bounded, revocable, reasoned grant that can be ended in one UPDATE without
-- touching the customer's own sessions.
--
-- Account-scoped, not tenant-scoped: this table sits with `accounts`,
-- `staff_roles` and `admin_action_audit` on the platform-global side of the RLS
-- split (docs/rls.md), so it stays off RLS and on the default pool.
--
-- There is deliberately no `mode` column. A read-only mode cannot set anything
-- up on a customer's behalf, which is the reason the feature exists.

BEGIN;

CREATE TABLE support_delegation_sessions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- sha256 of the opaque ticket handed to the browser, never the ticket
  -- itself. A read of this table therefore yields no usable session, the same
  -- treatment accounts/signup-approval-tokens.ts gives approval tokens.
  ticket_hash       TEXT NOT NULL UNIQUE,

  actor_account_id  UUID NOT NULL REFERENCES accounts(id),
  target_account_id UUID NOT NULL REFERENCES accounts(id),

  -- Required, free text. A grant with no stated purpose is not auditable after
  -- the fact, and "why were you in my workspace" is the question this answers.
  reason            TEXT NOT NULL,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- There is no expiry: a support session that dies mid-repair is worse than one
  -- that outlives its usefulness. Checked on EVERY request, so ending a session
  -- takes effect on the next call.
  --
  -- Ending it is therefore the ONLY thing that stops a grant. Closing the tab
  -- clears the browser's copy of the ticket but leaves this row open, and the
  -- act-as URL sits in browser history, so a closed tab is not a revoked
  -- session. The Exit button calls the revoke endpoint for exactly this reason.
  -- Earlier revisions of this comment claimed a closed tab ended the session.
  -- It never did.
  ended_at          TIMESTAMPTZ,
  ended_by          UUID REFERENCES accounts(id),

  ip_address        INET,
  user_agent        TEXT,

  -- Nobody may delegate as themselves; that is not a support session, it is a
  -- confusing no-op that would defeat "who actually acted" in the audit trail.
  CONSTRAINT support_delegation_no_self CHECK (actor_account_id <> target_account_id)
);

-- The hot read is the middleware's per-request lookup, which is by ticket_hash
-- and served by the UNIQUE index above. These two serve the admin listings:
-- "who is in this customer's account right now" and "what has this admin done".
CREATE INDEX idx_support_delegation_target
  ON support_delegation_sessions (target_account_id, created_at DESC)
  WHERE ended_at IS NULL;

CREATE INDEX idx_support_delegation_actor
  ON support_delegation_sessions (actor_account_id, created_at DESC);

COMMIT;
