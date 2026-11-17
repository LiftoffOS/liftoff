-- Delete threads with exactly 1 assistant message and 0 user messages.

-- CROSS-TENANT MAINTENANCE, so RLS is lifted for the statement rather than
-- scoped to a tenant.
--
-- agent_chat_threads and agent_chat_messages are FORCE ROW LEVEL SECURITY, and
-- their policy reads current_setting('app.current_tenant_id')::uuid. The
-- migration runner sets no such GUC, so under FORCE the policy raises
--   error: unrecognized configuration parameter "app.current_tenant_id"
-- and the statement fails — taking the whole pending batch with it, because
-- node-pg-migrate applies them in one transaction.
--
-- Scoping to one tenant is not the fix: this is junk cleanup across ALL
-- tenants. FORCE is what makes RLS apply to the table owner too, so the
-- documented pattern for a system-wide write is to drop FORCE for the
-- statement and restore it immediately — the same shape
-- scripts/ci-fences/system-agent-rls-fence.sh requires of any migration
-- writing a system-agent row.

ALTER TABLE agent_chat_threads  NO FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_chat_messages NO FORCE ROW LEVEL SECURITY;

DELETE FROM agent_chat_threads
WHERE id IN (
  SELECT t.id
  FROM agent_chat_threads t
  INNER JOIN (
    SELECT thread_id
    FROM agent_chat_messages
    GROUP BY thread_id
    HAVING COUNT(*) = 1 AND COUNT(CASE WHEN role = 'user' THEN 1 END) = 0
  ) msg_counts ON t.id = msg_counts.thread_id
);


ALTER TABLE agent_chat_messages FORCE ROW LEVEL SECURITY;
ALTER TABLE agent_chat_threads  FORCE ROW LEVEL SECURITY;
