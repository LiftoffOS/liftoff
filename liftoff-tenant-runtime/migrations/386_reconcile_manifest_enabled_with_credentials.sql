-- Repair what migration 385 got wrong, and the drift that misled it.
--
-- 385 withdrew every enabled manifest whose `connectors.status` was not
-- 'active'. That predicate was wrong, because `connectors.status` is not
-- maintained on reconnect: the connect handler's UPSERT is
--
--     INSERT INTO connectors (...) VALUES (..., 'active')
--     ON CONFLICT (id) DO UPDATE SET type = EXCLUDED.type, updated_at = NOW()
--
-- and the conflict branch never restores `status`. So a connector that was
-- disconnected and then reconnected under the SAME id keeps `disconnected`
-- forever, while its manifest is correctly re-enabled and a fresh active
-- credential is written. That state is indistinguishable, from `connectors`
-- alone, from a manifest the broken disconnect handler failed to withdraw —
-- and 385 read it as the latter, so it can disable LIVE connectors.
--
-- `connector_credentials.status` is the signal that is maintained in both
-- directions: connect UPSERTs `status = 'active'` explicitly, and disconnect
-- revokes keyed on connector_id, which is the one write in that handler that
-- always worked. So it is the authority for whether a connector is live.
--
-- Two repairs, in order. Both idempotent, and both scoped to rows where the
-- two tables actually disagree so a re-run is a no-op.

-- 1. `connectors.status`, which the reconnect UPSERT never restored. Without
--    this the drift stays and any future predicate reading it is misled again.
UPDATE connectors c
   SET status = 'active',
       updated_at = NOW()
  FROM connector_credentials cc
 WHERE cc.connector_id = c.id
   AND cc.status = 'active'
   AND c.status IS DISTINCT FROM 'active';

-- 2. `connector_manifests.enabled`, reconciled to the credential. This both
--    re-enables what 385 wrongly withdrew and keeps withdrawn what it rightly
--    did — a revoked credential means the tools cannot work, so advertising
--    them to an agent is the original defect.
--
--    A manifest with no credential row at all is left exactly as it is: there
--    is no signal to act on, and inventing one is what caused this.
UPDATE connector_manifests m
   SET enabled = (cc.status = 'active'),
       updated_at = NOW()
  FROM connector_credentials cc
 WHERE cc.connector_id = m.id
   AND m.enabled IS DISTINCT FROM (cc.status = 'active');
