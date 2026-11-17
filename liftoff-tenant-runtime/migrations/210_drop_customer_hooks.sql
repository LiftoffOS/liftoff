-- migrations/210_drop_customer_hooks.sql
--
-- Drops the customer-hooks (PreToolUse webhook policies) feature.
-- Agent governance is now driven entirely by /oversight. The SDK seam
-- and webhook-client primitive are kept in code for future internal use,
-- but no tenant-configurable surface or persistence remains.
--
-- Affects: customer_hooks, customer_hook_invocations,
-- tenants.customer_hooks_enabled, hitl_approval_requests.hook_source,
-- hitl_approval_requests.hook_id, audit_logs.hook_source.

-- 1. Drop the FK column on hitl_approval_requests before dropping its
--    target table (or rely on DROP TABLE ... CASCADE; explicit drop is
--    safer because it leaves the foreign-key error trail visible if the
--    column has been removed independently).
ALTER TABLE hitl_approval_requests
  DROP COLUMN IF EXISTS hook_id;

ALTER TABLE hitl_approval_requests
  DROP COLUMN IF EXISTS hook_source;

-- 2. Cross-reference column on audit_logs.
ALTER TABLE audit_logs
  DROP COLUMN IF EXISTS hook_source;

-- 3. Drop the invocation ledger (referenced customer_hooks via FK).
DROP TABLE IF EXISTS customer_hook_invocations;

-- 4. Drop the hooks table.
DROP TABLE IF EXISTS customer_hooks;

-- 5. Remove the tenant-level kill switch.
ALTER TABLE tenants
  DROP COLUMN IF EXISTS customer_hooks_enabled;
