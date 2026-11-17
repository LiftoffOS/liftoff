-- Drop this service's copy of tool_classification_cache.
--
-- It has never held a row. It arrived with migration 001, copied out of
-- platform-backend's 028 + 081 + 083a during the extraction, and nothing in
-- THIS service has ever read or written it: the only code that names it is
-- scripts/classify-connector-tools.ts and scripts/audit-hris-classification.ts,
-- and both GENERATE SQL whose header says to paste it into a platform-backend
-- migration. The live table is that one, read by platform-backend's
-- src/mcp/tool-classifier.ts. This copy is a second, empty home for the same
-- idea in a database no reader points at.
--
-- Dropping rather than wiring it up, because the question it answers has since
-- been answered somewhere better. Tool categories are DECLARED now, not cached:
-- native functions carry `categories` in the connector-functions registry, and
-- composio tools carry `categoryOverrides` in @liftoffos/composio-overlays,
-- merged at boot. Both are in source, reviewed, and versioned, and as of this
-- migration a function missing a category cannot start the service at all
-- (src/catalog/category-validator.ts). A cache in front of a declaration is a
-- second source of truth that can disagree with the first.
--
-- Its key was also wrong for the job. PRIMARY KEY (tool_name, tenant_id) makes
-- the tool name globally unique, but a tool name is only unique WITHIN a
-- connector: `read_message` exists on slack, on gmail and on teams, and they
-- are not the same tool or the same categories. The integration_type column
-- that would have made the key correct is present and not in the key. Anything
-- wired to this table would have had the first connector's classification
-- answer for every other connector's tool of the same name.
--
-- An empty table is a safe drop: there is nothing to back up and nothing to
-- migrate. Its RLS policies and its GRANT to connector_admin go with it.

BEGIN;

DROP TABLE IF EXISTS tool_classification_cache CASCADE;

COMMIT;
