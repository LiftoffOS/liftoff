-- One live sandbox per session, enforced by the database.
--
-- getOrCreate read sandbox_state, found nothing, provisioned (~1 minute), and
-- only THEN inserted the row. For that whole minute the session had no row, so
-- the read-then-create sequence had nothing to serialise on: two calls arriving
-- in the window each provisioned a Cloud Run service and each billed a
-- provision. The window is also where services leak — a create that throws
-- before the insert leaves a service with no row at all, which is what the GC
-- sweep's Cloud Run phase exists to mop up.
--
-- With this index the INSERT itself is the claim: the winner provisions, the
-- loser sees the 'creating' row and is told to retry. 'destroyed' and 'error'
-- are excluded so a session can legitimately provision again after its sandbox
-- goes away.

-- Any session that already holds more than one live row is a product of the
-- window this index closes. Retire all but the newest so the index can be
-- built: a unique index that fails to create aborts the migrate step and
-- blocks every deploy behind it, and these rows are exactly the duplicates
-- the constraint is meant to prevent. 'error' (not 'destroyed') because the
-- backing service may still exist — the GC sweep destroys on that status and
-- the alive-billing ticker stops counting it.
UPDATE sandbox_state s
   SET status = 'error'
 WHERE s.status NOT IN ('destroyed', 'error')
   AND EXISTS (
     SELECT 1 FROM sandbox_state peer
      WHERE peer.session_id = s.session_id
        AND peer.status NOT IN ('destroyed', 'error')
        AND (peer.created_at, peer.sandbox_id) > (s.created_at, s.sandbox_id)
   );

CREATE UNIQUE INDEX IF NOT EXISTS idx_sandbox_state_live_session
  ON sandbox_state (session_id)
  WHERE status NOT IN ('destroyed', 'error');
