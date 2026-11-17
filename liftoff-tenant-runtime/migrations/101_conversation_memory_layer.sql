-- Add 'conversation' as a valid memory layer.
-- Conversation-layer memories are scoped to a single chat thread (scope_key = threadId)
-- and never surface in any other conversation. They expire after 7 days.
ALTER TABLE memories
  DROP CONSTRAINT memories_layer_check,
  ADD CONSTRAINT memories_layer_check
    CHECK (layer IN ('global', 'role', 'individual', 'conversation'));
