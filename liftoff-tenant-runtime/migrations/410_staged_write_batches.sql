-- A staged write batch: the host's record of what a `writeRole: 'stage'` tool
-- prepared, so that ONE approval can cover it and ONE apply can commit it.
--
-- A job that is N line-level writes gets one ask covering the staged batch
-- rather than a pause per line, and the single mark covers exactly what the
-- apply commits. The connector declares the pair (`writeRole`, `paired_apply`,
-- validated at connector-service boot); this table is the runtime half the
-- declaration had none of: nothing staged, nothing bound a mark to an item
-- set, and "apply" would have been N ordinary writes under one bypass.
--
-- Host-written throughout. The model holds only `id`, minted here and
-- unguessable; it never holds or passes the digest, the item set or the grant
-- (ADR-052 rule 5, clauses 2, 6 and 9).
--
--   digest        sha256 over the exact staged item set — the stage call's
--                 canonical arguments and the identifiers the vendor returned
--                 for what it prepared — computed here from the call the
--                 gateway dispatched, never from anything the model said.
--   binding       tenant, agent, the connector instance the batch was staged
--                 through and the apply tool that commits it. Apply on any
--                 other binding is refused (clause 3).
--   expires_at    the ask's own expiry, 24 hours (clause 4). A batch whose ask
--                 is rejected or whose run is withdrawn is cancelled, and
--                 neither an expired nor a cancelled batch can be applied.
--   approval_id / approved_digest
--                 written when a person approves the apply that names this
--                 batch: the grant lives here and on the approval row, both
--                 host-written (clauses 5 and 6). The digest a person approved
--                 is the digest the apply verifies.
--   applied_at / apply_result
--                 the apply's one act: keyed on (id, digest), a retry of a
--                 completed apply performs no second write and answers with
--                 the recorded result (clause 8).

CREATE TABLE IF NOT EXISTS staged_write_batches (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID        NOT NULL,
  agent_id         TEXT        NOT NULL,
  invocation_id    TEXT,
  connector        TEXT        NOT NULL,
  stage_tool       TEXT        NOT NULL,
  apply_tool       TEXT        NOT NULL,
  -- The identifiers the vendor returned for what it prepared, the way an apply
  -- names the batch (an apply's arguments carry the vendor's id, never ours).
  vendor_ids       TEXT[]      NOT NULL DEFAULT '{}',
  item_count       INTEGER     NOT NULL DEFAULT 1,
  digest           TEXT        NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'staged'
                   CHECK (status IN ('staged', 'approved', 'applied', 'cancelled', 'expired')),
  approval_id      UUID,
  approved_digest  TEXT,
  applied_at       TIMESTAMPTZ,
  apply_result     JSONB,
  cancel_reason    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at       TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours',
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- An apply finds its batch by the vendor id its arguments carry, within the
-- binding it runs under.
CREATE INDEX IF NOT EXISTS staged_write_batches_binding_idx
  ON staged_write_batches (tenant_id, agent_id, connector, status);
CREATE INDEX IF NOT EXISTS staged_write_batches_vendor_ids_idx
  ON staged_write_batches USING GIN (vendor_ids);
CREATE INDEX IF NOT EXISTS staged_write_batches_approval_idx
  ON staged_write_batches (approval_id) WHERE approval_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS staged_write_batches_expires_idx
  ON staged_write_batches (expires_at) WHERE status IN ('staged', 'approved');

ALTER TABLE staged_write_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE staged_write_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY staged_write_batches_tenant ON staged_write_batches
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

COMMENT ON TABLE staged_write_batches IS
  'Host-written record of a staged write batch: what a writeRole=stage tool prepared, bound to tenant/agent/connector/apply tool, digested over the staged item set, expiring with its ask, approved by digest, applied once. The model holds only the id.';
COMMENT ON COLUMN staged_write_batches.digest IS
  'sha256 over the canonical stage arguments and the vendor identifiers returned; computed by the host from the dispatched call, never supplied by the model.';
COMMENT ON COLUMN staged_write_batches.approved_digest IS
  'The digest a person approved, written with the approval; the apply verifies the batch digest against it and refuses any other.';
