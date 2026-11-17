-- Drop knowledge_items_connector_id_fkey. The FK points at a table that is
-- not the authority for the ids stored in the column, so it rejects almost
-- every insert it sees.
--
-- `knowledge_items.connector_id` holds a CONNECTOR-SERVICE connector id. That
-- service owns its own database (`connector_service`) — a different
-- database from this control plane's `liftoff_control`. Every connector the
-- user can pick from — the list behind `GET /api/connectors`, the id the
-- knowledge file picker sends, the ids in `internal_agents.integrations` that
-- `corpus_search` scopes retrieval by — comes from THAT database.
--
-- The `connectors` table in THIS database is a pre-cutover remnant. It stopped
-- receiving connector rows when `/api/connectors/*` was moved behind the proxy
-- (Phase 2a), except for `custom_mcp_server` rows, which this repo still writes
-- itself (src/custom-mcp-servers/service.ts). The only ids it shares with
-- `connector_service` belong to connectors created before the cutover.
--
-- So migration 267, which added this FK, could not hold:
--
--   * Its "orphan" cleanup was wrong. A row whose connector is missing from
--     the local connectors table can still point at a connector that is
--     ACTIVE in connector-service, so deleting it deletes live knowledge, not
--     an orphan.
--
--   * The constraint rejects every insert whose connector post-dates the
--     cutover. `POST /api/knowledge/batch` returns 500 on every
--     connector-sourced add — the frontend shows "Failed to add items" — and
--     the sync, folder-expansion and webhook import paths fail the same way.
--
-- A foreign key cannot span two databases, so there is nothing to repoint it
-- at. Referential integrity across that boundary is maintained the way every
-- other cross-service reference here is: connector-service publishes
-- `connector.deleted` on the shared control-plane topic, and this repo's
-- subscriber deletes the dependent rows (src/events/subscriber.ts). That
-- handler already scrubs `internal_agents.integrations` and the knowledge
-- webhook subscriptions for the dead connector; this change adds the
-- `knowledge_items` delete that the CASCADE was standing in for.
--
-- The column stays UUID (267's other half was correct — the ids are UUIDs).
-- See docs/adr/049-connector-id-space-is-cross-database.md.

BEGIN;

ALTER TABLE knowledge_items
  DROP CONSTRAINT IF EXISTS knowledge_items_connector_id_fkey;

COMMIT;
