-- Response paths the runtime learned from real traffic, and whether a person
-- accepted them.
--
-- The write gate needs two facts per tool: which ARGUMENTS of a write name a
-- record, and where ids appear in a read's RESULT. The first is derivable from
-- an input schema and now is, at the boundary every tool enters by. The second
-- is not derivable by anyone — nothing about a tool's arguments says what its
-- response contains — so it is observed: the gateway records the id-bearing
-- PATHS of each read that passes it.
--
-- Observed shapes lived in an in-memory Map. They were thrown away on every
-- restart and the function that read them had no caller, so a night's learning
-- reached nobody and did not survive the morning.
--
-- PATHS ONLY, never values. `items[].id` is a fact about a tool's shape; the
-- ids themselves are customer data and have no business outliving the request.
--
-- Per tenant because the runtime is. A customer's own MCP server has shapes
-- nobody else can see, which is the case that rules out a shared catalog for
-- this: there is no central place that could know them.
CREATE TABLE learned_response_shapes (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL,
  connector_type    TEXT NOT NULL,
  action_type       TEXT NOT NULL,
  path              TEXT NOT NULL,
  -- What the id at this path identifies, once somebody says. Null until then:
  -- the observer sees a path, not what a record is called.
  entity_type       TEXT,
  -- pending → a proposal. accepted → the gate reads it. rejected → it does not,
  -- and it is not proposed again, which is what stops a review queue rotting.
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'accepted', 'rejected')),
  -- How many separate reads returned an id at this path. A path seen once may
  -- be a fluke; a path seen a thousand times is the tool's shape.
  observed_count    BIGINT NOT NULL DEFAULT 1,
  first_observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_observed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at        TIMESTAMPTZ,
  decided_by        TEXT,
  UNIQUE (tenant_id, connector_type, action_type, path)
);

-- The gate's read: every accepted path for one tool, on the hot path of a
-- schema-cache refresh.
CREATE INDEX idx_lrs_accepted
  ON learned_response_shapes (tenant_id, connector_type, action_type)
  WHERE status = 'accepted';

-- The review queue's read: what is waiting, most-seen first.
CREATE INDEX idx_lrs_pending
  ON learned_response_shapes (tenant_id, observed_count DESC)
  WHERE status = 'pending';

-- This runtime serves every tenant in one database, so a table carrying a
-- tenant_id and no policy is one forgotten WHERE clause from another
-- customer's rows. That matters more here than the paths-only rule suggests:
-- a custom MCP server's tool names are the customer's own vocabulary, and
-- leaking which tools a workspace has is leaking what it does.
ALTER TABLE learned_response_shapes ENABLE ROW LEVEL SECURITY;
ALTER TABLE learned_response_shapes FORCE ROW LEVEL SECURITY;
CREATE POLICY learned_response_shapes_tenant ON learned_response_shapes
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

COMMENT ON TABLE learned_response_shapes IS
  'Id-bearing response paths observed from real traffic, pending or accepted as returnsIds declarations. Paths only, never values.';
