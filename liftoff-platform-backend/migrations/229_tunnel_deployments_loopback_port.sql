-- Migration 229: per-deployment loopback port for in-container chisel dispatch
--
-- Each tunnel deployment is assigned a unique TCP port in the 20000-29999 range
-- that the tunnel-service's in-container chisel server binds when the customer
-- chisel client connects with `R:<port>:upstream-host:upstream-port`. The
-- dispatcher then dials `localhost:<port>` to forward HTTP requests through
-- to the customer's network. Cloud Run only exposes one external port, but
-- nothing prevents binding many loopback-only ports inside the container.
--
-- Port range 20000-29999 gives us 10000 simultaneously-connected deployments
-- per tunnel-service replica, which is plenty for the foreseeable future.
-- Range is well above ephemeral port territory (32768+) and well below any
-- privileged ports.

ALTER TABLE mcp_tunnel_deployments
  ADD COLUMN loopback_port INTEGER;

-- Backfill: any existing deployments get a random port.
UPDATE mcp_tunnel_deployments
SET loopback_port = 20000 + (floor(random() * 10000)::int)
WHERE loopback_port IS NULL;

ALTER TABLE mcp_tunnel_deployments
  ALTER COLUMN loopback_port SET NOT NULL;

ALTER TABLE mcp_tunnel_deployments
  ADD CONSTRAINT mcp_tunnel_deployments_loopback_port_range
  CHECK (loopback_port BETWEEN 20000 AND 29999);

-- Uniqueness is enforced per-replica at the application level (random
-- allocation + insert-conflict retry); no global uniqueness here because
-- different tunnel-service replicas bind their own loopback namespaces.
-- A non-unique index is enough for the rare `SELECT … WHERE loopback_port = ?`
-- lookups (none today; here for future).
CREATE INDEX idx_mcp_tunnel_deployments_loopback_port
  ON mcp_tunnel_deployments(loopback_port);
