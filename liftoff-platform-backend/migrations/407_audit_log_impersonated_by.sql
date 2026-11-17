-- Migration 407: record WHO REALLY ACTED when a support session writes.
--
-- audit_log.user_id is the identity a request was ANSWERED as. Support
-- delegation (migration 406) rewrites that identity on purpose, so without this
-- column every row a support session produces is indistinguishable from one the
-- customer produced, for us as well as for them.
--
-- Scope is deliberate and asymmetric:
--
--   INTERNAL. The column is written on every row a session produces and is
--   queryable directly. "Show me every action support ever took in a customer
--   workspace" is a question a security review asks, and this is the answer.
--
--   NOT CUSTOMER-FACING. The tenant audit feed (src/audit-log/repository.ts)
--   deliberately does NOT select it, and the CSV export deliberately does not
--   show it. A support session is meant to read as the customer from inside the
--   product; advertising it back to them in their own export was a transparency
--   feature we decided against.
--
-- Nullable, and NULL on every ordinary row: the presence of a value is itself
-- the statement that somebody was acting on this account's behalf.
--
-- Deliberately a column rather than a key inside `metadata`, which already
-- exists and would need no migration. A JSONB scan across the whole audit
-- history is a poor way to answer the one question this exists to answer.

BEGIN;

ALTER TABLE audit_log ADD COLUMN impersonated_by UUID REFERENCES accounts(id);

-- Partial: the overwhelming majority of rows are NULL, and the only query this
-- serves is "everything done under delegation", newest first.
CREATE INDEX idx_audit_log_impersonated_by
  ON audit_log (impersonated_by, timestamp DESC)
  WHERE impersonated_by IS NOT NULL;

COMMIT;
