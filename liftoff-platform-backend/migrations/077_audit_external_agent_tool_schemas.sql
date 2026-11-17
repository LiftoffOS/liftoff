-- Audit existing external_agents.raw_mcp_tools rows for invalid tool schemas
-- that the previous (broken) MCPToolDefinition type silently allowed.
--
-- Background:
--
--   Before this PR, src/external-agents/types.ts declared
--   MCPToolDefinition.inputSchema.properties values as
--     { type: string; description?; enum?; default? }
--   with no `items`, no nested `properties`, no `requiredFields`. Any MCP
--   server's tools/list response that included a complex schema (e.g., an
--   array property with `items: { type: 'object' }`) had its `items` field
--   silently stripped on its way through the type-cast in MCPClient.discover().
--   The stripped schema was then persisted into raw_mcp_tools as JSONB.
--
--   The result: tenants whose MCP servers returned correct schemas can still
--   have malformed copies in our database, and at agent execution time the
--   LLM provider rejects those schemas with
--     400 Invalid schema for function 'X':
--     In context=('properties', 'Y'), array schema missing items.
--
-- This migration is a DIAGNOSTIC, NOT a fix. It logs every external_agents
-- row whose raw_mcp_tools contains a property with `type: 'array'` but no
-- `items` field. Operators are then expected to:
--
--   1. Look at the migration job log output for the affected (tenant, agent)
--      pairs
--   2. For each affected row, trigger a fresh discovery via the existing
--      "Re-discover" button in the external agents UI (or via the admin
--      endpoint if you prefer scripting it). The new discovery will run
--      through MCPClient.discover() which now validates schemas with ajv
--      before persisting, so a re-discovery either updates the row with the
--      correct schemas (if the MCP server is well-behaved) or fails loudly
--      with a structured error (if the MCP server itself is broken).
--
-- We do NOT auto-mutate the data here because the only thing that knows
-- what the correct schema should be is the MCP server itself. Guessing
-- `items: { type: 'object' }` to fill in the gap would be wrong for
-- arrays-of-strings, arrays-of-numbers, etc. The right answer is "ask the
-- server again, validate the response, persist if valid."

DO $$
DECLARE
  agent_row RECORD;
  tool jsonb;
  prop_key text;
  prop_value jsonb;
  affected_count INTEGER := 0;
  violation_paths text[];
BEGIN
  RAISE NOTICE 'Auditing external_agents.raw_mcp_tools for type:array missing items...';

  FOR agent_row IN
    SELECT id, tenant_id, name, raw_mcp_tools
    FROM external_agents
    WHERE deleted_at IS NULL
      AND raw_mcp_tools IS NOT NULL
      AND jsonb_typeof(raw_mcp_tools) = 'array'
      AND jsonb_array_length(raw_mcp_tools) > 0
  LOOP
    violation_paths := ARRAY[]::text[];

    -- Walk every tool in raw_mcp_tools
    FOR tool IN SELECT jsonb_array_elements(agent_row.raw_mcp_tools)
    LOOP
      -- Walk every top-level property in the tool's inputSchema.properties
      IF tool->'inputSchema' IS NOT NULL
         AND tool->'inputSchema'->'properties' IS NOT NULL
         AND jsonb_typeof(tool->'inputSchema'->'properties') = 'object'
      THEN
        FOR prop_key, prop_value IN
          SELECT * FROM jsonb_each(tool->'inputSchema'->'properties')
        LOOP
          -- Flag this property if it's a bare type:array with no items
          IF prop_value->>'type' = 'array' AND NOT (prop_value ? 'items') THEN
            violation_paths := array_append(
              violation_paths,
              format('%s.%s', tool->>'name', prop_key)
            );
          END IF;
        END LOOP;
      END IF;
    END LOOP;

    IF array_length(violation_paths, 1) > 0 THEN
      affected_count := affected_count + 1;
      RAISE NOTICE 'AFFECTED  external_agent_id=% tenant_id=% name=% violations=%',
        agent_row.id,
        agent_row.tenant_id,
        agent_row.name,
        array_to_string(violation_paths, ', ');
    END IF;
  END LOOP;

  IF affected_count = 0 THEN
    RAISE NOTICE 'AUDIT COMPLETE: 0 affected rows. All raw_mcp_tools schemas are valid.';
  ELSE
    RAISE NOTICE 'AUDIT COMPLETE: % affected row(s). Trigger re-discovery via the external agents UI to repair each.', affected_count;
  END IF;
END $$;
