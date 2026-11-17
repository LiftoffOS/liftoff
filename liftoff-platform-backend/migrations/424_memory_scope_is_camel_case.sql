-- Memory scope was stored in a spelling nothing reads.
--
-- Every type, schema and reader in both repositories is camelCase: the
-- `MemoryScope` interface here and in the tenant runtime, the router's Zod gate,
-- the template catalog's `defaultMemoryScope`, and `StandardToolContext`. The
-- create path wrote the default in snake_case:
--
--     JSON.stringify(input.memoryScope || { readable_layers: [...], writable_layers: [...] })
--
-- `parseJsonb` returns valid JSON as it stands, so its camelCase fallback never
-- fired and the snake_case object travelled on cast as `MemoryScope`. The cast
-- is why TypeScript never objected. The value then went verbatim through the
-- create event into the tenant runtime's own `agents.memory_scope`, where
-- `ctx.memoryScope.writableLayers` read undefined and the handler fell back to a
-- hard-coded list.
--
-- So an agent created through the hire flow does not have its memory scope
-- enforced as configured. Rows written by that path are in the unreadable
-- spelling; only system agents, seeded by another path, are readable. The
-- symptom is that `SELECT layer, count(*) FROM memories` in the tenant runtime
-- returns `individual` and `global` and nothing else: the `role` layer is
-- never written to.
--
-- The reader is normalised in the same change (`memory-scope.ts`), so this is
-- not what makes the platform correct — it makes the STORED data agree with the
-- type that describes it, which is what keeps the next reader from having to
-- know this story.
--
-- Idempotent: it only rewrites rows carrying the old keys, and re-running it
-- finds none.

-- RLS. `internal_agents` is FORCE row-level-security and this rewrites rows
-- across every tenant, so no single tenant scope could be bound. Migrations run
-- as liftoff_app, which owns the table, so dropping FORCE for the length of this
-- transaction is the owner's equivalent of the admin pool's BYPASSRLS; ALTER
-- TABLE holds ACCESS EXCLUSIVE until COMMIT, so no other session observes the
-- table unforced. Same shape as 417 and 419.

BEGIN;

ALTER TABLE internal_agents NO FORCE ROW LEVEL SECURITY;

-- Renames the three keys where present, leaving any camelCase key already there
-- untouched. `-` drops the old key only after its value has been carried across,
-- and a row holding both spellings keeps the camelCase value, which is the shape
-- the type declares.
UPDATE internal_agents
   SET memory_scope = (
         CASE WHEN memory_scope ? 'readable_layers' AND NOT memory_scope ? 'readableLayers'
              THEN jsonb_set(memory_scope, '{readableLayers}', memory_scope->'readable_layers')
              ELSE memory_scope END
       )
       - 'readable_layers',
       updated_at = NOW()
 WHERE memory_scope ? 'readable_layers';

UPDATE internal_agents
   SET memory_scope = (
         CASE WHEN memory_scope ? 'writable_layers' AND NOT memory_scope ? 'writableLayers'
              THEN jsonb_set(memory_scope, '{writableLayers}', memory_scope->'writable_layers')
              ELSE memory_scope END
       )
       - 'writable_layers',
       updated_at = NOW()
 WHERE memory_scope ? 'writable_layers';

UPDATE internal_agents
   SET memory_scope = (
         CASE WHEN memory_scope ? 'scope_keys' AND NOT memory_scope ? 'scopeKeys'
              THEN jsonb_set(memory_scope, '{scopeKeys}', memory_scope->'scope_keys')
              ELSE memory_scope END
       )
       - 'scope_keys',
       updated_at = NOW()
 WHERE memory_scope ? 'scope_keys';

ALTER TABLE internal_agents FORCE ROW LEVEL SECURITY;

COMMIT;
