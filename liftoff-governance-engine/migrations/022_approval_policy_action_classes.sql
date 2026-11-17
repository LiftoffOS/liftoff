-- Class-scoped standing policies. When a human approves an external-content write
-- gate with "always apply", the policy stores exactly the action classes observed
-- on the approved call, so the grant is scoped to those classes rather than the
-- whole gate reason. NULL = a legacy reason-wide policy, which deliberately does
-- NOT clear the external_content_write gate (it clears only the reason-wide gates
-- that predate this column).
ALTER TABLE hitl_approval_policies ADD COLUMN IF NOT EXISTS action_classes TEXT[];
