-- Recover the identity of things agents CREATED, from the responses already stored.
--
-- `deriveTarget` reads the payload, and a create's payload carries a title and
-- a body and no id: the id exists only in the response. So every artifact an
-- agent produced was recorded with an empty `target_ref`, and every surface
-- that reads the ledger by target skipped exactly the rows describing the
-- agent's own output.
--
-- So an agent looking for its own documents (a watch list, a snapshot, weekly
-- digests) fails to find them and reports them absent, while its updates,
-- which carry an id in the payload, are keyed.
--
-- Forward, `recordOutcome` derives the target from the response with the same
-- `deriveTarget` the payload path uses, so a document created on one run and
-- updated on the next collapses to ONE artifact. This recovers the history.
--
-- THE PREFIX IS LEARNED, NOT ASSUMED. A target is `<connector type>:<id>`, and
-- the type is not the `connector` column — that holds the connector INSTANCE
-- (`google-docs-8fd9fc68` against a `google-docs:` prefix), and the mapping
-- between them lives in TypeScript. So rather than reimplement it, this reads
-- the prefix each connector's own keyed rows already use. A connector with no
-- keyed row is left alone: there is nothing to learn from, and a guessed prefix
-- would file an artifact under a key nothing else will ever look up.
WITH learned_prefix AS (
  SELECT connector, split_part(target_ref, ':', 1) AS type, count(*) AS n,
         row_number() OVER (PARTITION BY connector ORDER BY count(*) DESC) AS rank
    FROM actions
   WHERE target_ref <> '' AND position(':' IN target_ref) > 0
   GROUP BY connector, split_part(target_ref, ':', 1)
),
one_prefix_each AS (
  SELECT connector, type FROM learned_prefix WHERE rank = 1
),
recovered AS (
  SELECT a.id,
         p.type || ':' || COALESCE(
           a.external_response->>'documentId',
           a.external_response->>'fileId',
           a.external_response->>'spreadsheetId',
           a.external_response->>'presentationId',
           a.external_response->>'messageId',
           a.external_response->>'id'
         ) AS ref
    FROM actions a
    JOIN one_prefix_each p ON p.connector = a.connector
   WHERE a.target_ref = ''
     AND a.connector <> 'execution_environment'
     AND a.status IN ('completed', 'succeeded')
     AND jsonb_typeof(a.external_response) = 'object'
     AND COALESCE(
           a.external_response->>'documentId',
           a.external_response->>'fileId',
           a.external_response->>'spreadsheetId',
           a.external_response->>'presentationId',
           a.external_response->>'messageId',
           a.external_response->>'id'
         ) IS NOT NULL
)
UPDATE actions a
   SET target_ref = r.ref,
       -- A row that produced an identifiable artifact IS an outward write. The
       -- verb backfill in 388 could not reach these: it required a target, and
       -- having no target is the whole condition being repaired here.
       is_external_write = true
  FROM recovered r
 WHERE a.id = r.id;
