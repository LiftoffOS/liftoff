-- Loosen the custom_mcp_servers delivery_mode / tunnel_route_id consistency
-- check so a tunneled consumer survives when its referenced route is deleted.
--
-- Per the plan (§Data model, lines 152-153): "Deleting a route SET NULLs the
-- consumer FK; the consumer's endpoint_url then stops resolving and tool calls
-- fail with a clear error — the customer either re-creates the route or
-- deletes the consumer."
--
-- The original CHECK required (delivery_mode='tunneled' → tunnel_route_id IS
-- NOT NULL). Combined with the FK's ON DELETE SET NULL on tunnel_route_id,
-- deleting a route raised the CHECK and aborted the delete cascade. End-to-end
-- testing caught this; the loosened CHECK below keeps public_url's invariant
-- (must have NULL route_id) while permitting tunneled rows to have either
-- a bound route_id or NULL (the "broken reference" state).

ALTER TABLE custom_mcp_servers
  DROP CONSTRAINT custom_mcp_servers_check;

ALTER TABLE custom_mcp_servers
  ADD CONSTRAINT custom_mcp_servers_check
  CHECK (
    delivery_mode = 'tunneled'
    OR (delivery_mode = 'public_url' AND tunnel_route_id IS NULL)
  );
