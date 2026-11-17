-- Migration 494: retire the connected-tool inbox rows
--
-- The MCP server no longer offers liftoff_send_message / liftoff_read_messages
-- (dashboard-parity decision: a connected tool does what a person
-- can do in the dashboard, and the dashboard has no inbox). Two row classes in
-- agent_messages belong to the retired pathway:
--
--   recipient_type = 'claude_code'  a message addressed to a connected tool.
--       With the client-side reader gone, no code path can ever mark one read;
--       a pending row here is a mailbox with no reader.
--   sender_type = 'claude_code'     a message a connected tool queued for an
--       AI team. A team's own read_agent_messages could still surface one
--       mid-run, months after the pathway that produced it was retired and
--       with no surface left that shows where it came from — so the pending
--       backlog goes with the pathway.
--
-- Read rows stay: they are history, not a queue.
--
-- Data-touching statements on a FORCE-RLS table run inside the NO FORCE /
-- FORCE wrap so the migration role is not refused by the tenant policy.

ALTER TABLE agent_messages NO FORCE ROW LEVEL SECURITY;

DELETE FROM agent_messages
 WHERE recipient_type = 'claude_code'
   AND status = 'pending';

DELETE FROM agent_messages
 WHERE sender_type = 'claude_code'
   AND recipient_type = 'internal_agent'
   AND status = 'pending';

ALTER TABLE agent_messages FORCE ROW LEVEL SECURITY;
