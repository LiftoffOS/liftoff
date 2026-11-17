-- 359: agent_run_states schema 1.1 → 1.2 — give every run item an identity.
--
-- 1.2 adds two fields to each entry of state->'items':
--   id       — stable identity, unique within the run
--   parentId — the id of the item this one followed; NULL for the first
--
-- A one-time in-place upgrade rather than a read-time translator, matching the
-- 1.0 → 1.1 decision and for the same reason: agent_run_states has no TTL, so a
-- translator would never stop being maintained. The read path supports exactly
-- one version and fail-closes on anything else, so the two must move together.
--
-- BOTH version fields are updated. The table carries the version TWICE — the
-- schema_version column (migration 113) and state->>'$schemaVersion' inside the
-- JSONB — and only the JSON one is validated on read (run-state/service.ts).
-- Updating one and not the other leaves them silently divergent and turns the
-- column into decoration that later readers cannot trust.
--
-- parentId is assigned by ARRAY ORDER, which is the only linkage a flat array
-- can express and is exactly what the write path produces going forward: the
-- item at index N follows the item at index N-1. Nothing branches yet, so this
-- reconstruction is complete rather than approximate.
--
-- Idempotent: the WHERE clause matches only rows still at 1.1, so a re-run is a
-- no-op rather than a second pass that would re-mint every id and break any
-- parent link already recorded.

UPDATE agent_run_states
   SET state = jsonb_set(
                 jsonb_set(
                   state,
                   '{items}',
                   COALESCE(
                     (
                       SELECT jsonb_agg(
                                linked.item
                                  || jsonb_build_object('id', linked.item_id)
                                  || jsonb_build_object('parentId', linked.parent_id)
                                ORDER BY linked.ord
                              )
                         FROM (
                           -- The LAG has to be resolved in its own SELECT. A
                           -- window function may not appear inside an aggregate's
                           -- arguments (42803), so computing the parent link in
                           -- the same expression as the jsonb_agg is rejected at
                           -- parse time, before a single row is touched.
                           SELECT minted.item,
                                  minted.ord,
                                  minted.item_id,
                                  -- The previous element's freshly-minted id, or
                                  -- NULL at index 0, over the same ordering the
                                  -- items were stored in.
                                  LAG(minted.item_id) OVER (ORDER BY minted.ord) AS parent_id
                             FROM (
                               SELECT elem AS item,
                                      ord,
                                      gen_random_uuid()::text AS item_id
                                 FROM jsonb_array_elements(COALESCE(state->'items', '[]'::jsonb))
                                        WITH ORDINALITY AS t(elem, ord)
                             ) AS minted
                         ) AS linked
                     ),
                     '[]'::jsonb
                   ),
                   false
                 ),
                 '{$schemaVersion}',
                 '"1.2"'::jsonb,
                 false
               ),
       schema_version = '1.2',
       updated_at = now()
 WHERE state->>'$schemaVersion' = '1.1';

COMMENT ON COLUMN agent_run_states.schema_version IS
  'Duplicate of state->>''$schemaVersion'', kept as a column so a version sweep does not have to parse every JSONB document. The READ path validates the JSON copy only (agent-execution/run-state/service.ts), so any migration that moves one MUST move the other — otherwise this column becomes decoration that disagrees with the document it describes. Currently 1.2: run items carry id + parentId.';
