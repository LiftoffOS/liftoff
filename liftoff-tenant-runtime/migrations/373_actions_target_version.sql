-- Give the action ledger a version dimension, and an index that makes
-- "have I already acted on this?" a cheap question.
--
-- `actions.target_ref` has existed since migration 001 and answered almost
-- nothing: only a small fraction of rows carried a usable target, and writes
-- essentially never did. Every write site filled the column with `payload?.id || payload?.targetRef || ''`, and real
-- tool payloads do not carry `id` — a Slack send is `{channel, text}`, Gmail is
-- `{thread_id}`, GitHub is `{owner, repo, pull_number}`. The derivation now
-- lives in src/action-ledger/target-ref.ts; this migration adds the two things
-- the column alone could not express.
--
-- WHY VERSION IS ITS OWN COLUMN, NOT PART OF target_ref.
-- "Have I reviewed PR #29" is the wrong question. "Have I reviewed PR #29 at
-- head sha a450b99" is the right one — the moment someone pushes a commit, the
-- previous answer stops being correct, and an agent that treats the old answer
-- as current skips work it should redo. Encoding the sha into target_ref would
-- give the correct dedup for that one question while destroying a different one
-- worth keeping: "everything I have ever done to this PR" needs the entity
-- identity to stay stable across revisions. Two columns keep both askable.
--
-- NULL means "the payload named no revision", which is the common case and is
-- not an error. A lookup that supplies no version matches any row for the
-- entity; a lookup that supplies one matches only rows recorded against it.
--
-- NO BACKFILL. Nothing here reconstructs targets for existing rows, and that is
-- deliberate: the payloads are still on the rows, but a backfill would have to
-- re-derive through code that has never run against them, and a wrong dedup key
-- is worse than an absent one — it makes an agent skip work it never did. The
-- ledger starts answering for actions recorded from this deploy forward, and
-- the lookup states the window it searched rather than implying it can see
-- further back than it can.

ALTER TABLE actions ADD COLUMN IF NOT EXISTS target_version VARCHAR(255);

COMMENT ON COLUMN actions.target_version IS
  'Revision of target_ref this action applied to (GitHub head sha, HTTP etag, '
  'vendor version token). NULL when the payload named no revision. Kept out of '
  'target_ref so entity identity stays stable across revisions.';

-- The lookup index. The question is always "this agent, this target, most
-- recent first", bounded by a retention window — so the ordering is in the
-- index rather than paid as a sort per call.
--
-- Partial on a non-empty target: rows with no derivable target can never
-- satisfy the lookup, and today they are the overwhelming majority of the
-- table. Excluding them keeps the index proportional to the rows that can
-- actually answer, instead of to everything ever dispatched.
CREATE INDEX IF NOT EXISTS idx_actions_target_lookup
  ON actions (tenant_id, agent_id, target_ref, created_at DESC)
  WHERE target_ref <> '';
