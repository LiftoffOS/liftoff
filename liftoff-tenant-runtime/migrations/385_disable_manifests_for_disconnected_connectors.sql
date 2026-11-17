-- Disable the connector manifests that `handleConnectorDisconnected` never
-- disabled.
--
-- That handler ran three writes in one transaction. Two keyed on the connector
-- id and landed: `connectors.status = 'disconnected'` and
-- `connector_credentials.status = 'revoked'`. The third matched
-- `connector_manifests` on `connectorType.replace(/_/g,'-')` — the bare type —
-- while connect has written `<type>-<first-8-of-connector-id>` since migration
-- 252. It matched nothing, every time, and an UPDATE matching nothing is not an
-- error, so the handler logged success.
--
-- The manifest is the table `getManifestsForAgent` reads and the agent's tool
-- catalog is built from, and it filters on `enabled = true`. So a disconnected
-- connector kept its tools advertised to every agent bound to that type, under
-- its own alias, indefinitely — and `code_session` refused outright for an
-- agent that appeared to hold two GitHub connectors when it held one.
--
-- `connectors` is the authority for this, not the connector service: the same
-- subscriber maintains both tables from the same events, and this only ever
-- withdraws a row the runtime already recorded as disconnected. Idempotent, and
-- a reconnect re-enables through the connect handler's UPSERT.
UPDATE connector_manifests m
   SET enabled = false,
       updated_at = NOW()
  FROM connectors c
 WHERE c.id = m.id
   AND c.tenant_id = m.tenant_id
   AND m.enabled = true
   AND c.status IS DISTINCT FROM 'active';
