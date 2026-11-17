-- Migration 429: a routine proposal can now change or stop a routine, not
-- only start one.
--
-- "Move my Friday reminder to 10am" and "stop the Friday reminder" had no
-- rail: agent_suggestions modelled exactly one action, starting something
-- new. Three columns carry the rest, and the accept path branches on them.
--
-- action        what the accept DOES with the prose: append a new routine
--               line (start), replace an existing one (change), or take one
--               out (stop). The prose stays the source of truth either way;
--               the trigger set is re-derived by the redistill that follows.
-- target_label  the routine as the person named it, resolved at registration
--               time against the live trigger set (companion labels, primary
--               reasoning) and prior accepted proposals. Display and audit;
--               the accept keys on replaces_prose.
-- replaces_prose the EXACT guidance line the accept rewrites or removes, when
--               the target is one this rail wrote (chat-born). Null for a
--               cadence born in the distilled responsibilities: those cannot
--               be string-replaced safely, so the accept appends a
--               superseding amendment instead and the distiller is told a
--               line that states it replaces or stops an earlier cadence
--               wins.
--
-- Existing rows are all starts, which is what the DEFAULT records.

ALTER TABLE agent_suggestions
  ADD COLUMN action TEXT NOT NULL DEFAULT 'start'
    CHECK (action IN ('start', 'change', 'stop')),
  ADD COLUMN target_label TEXT,
  ADD COLUMN replaces_prose TEXT;
