-- A connector row is one connected account. Migration 016 made
-- (tenant_id, type, externalAccountId) the identity of a row; the
-- (tenant_id, type, name) key from migration 001 predates that and contradicts
-- it: every connect flow names a row with the type's display name, so a second
-- account of a type, or a fresh connect while a disconnected row still holds
-- the name, could only fail. Rows are told apart by their account label, never
-- by their name.
ALTER TABLE connectors DROP CONSTRAINT IF EXISTS connectors_tenant_id_type_name_key;
