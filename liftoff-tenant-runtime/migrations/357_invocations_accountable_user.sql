-- 357: invocations.accountable_user_id + attribution_source.
--
-- `triggered_by_user_id` (migration 311) answers "who started this run", and for
-- a run nobody started — a schedule, a webhook, an agent waking itself — the
-- honest answer is nobody. That is the right answer to that question and the
-- wrong answer to the one people actually ask, which is "whose is this": whose
-- budget, whose review queue, whose problem when it goes wrong.
--
-- Two columns, because they are two different facts and collapsing them is how
-- a fabricated human gets written. The ORIGINATOR stays exactly as strict as it
-- is today. The ACCOUNTABLE party may be derived, and `attribution_source`
-- records how — so a consumer can tell a person who clicked from a person the
-- system inferred, and nobody has to guess which they are looking at.
--
-- The one-way invariant is a table CHECK rather than a convention: when there IS
-- an originator, they are the accountable party, full stop. Derivation may only
-- fill a hole, never override a known human. Encoded here because the failure it
-- prevents — a derived owner quietly replacing the person who actually acted —
-- is invisible in every query that would otherwise be written against it.
--
-- Deliberately ordered AFTER the attribution fix (the same change set stops
-- `human:<agent-uuid>` being written at all). A two-column accountability model
-- layered over a field that invents people is not an improvement; it is the same
-- wrong answer in two places.
--
-- attribution_source holds only what the runtime can actually determine:
-- direct_human, delegation, unattributed. Deriving an owner from the schedule
-- that fired, the reactive rule that matched, or the agent itself is the natural
-- extension, but no owner exists here to derive from — companion routines live
-- in the agent's runtime config with no creator, reactive subscriptions are
-- owned in the control plane, and neither `agents` nor `cached_internal_agents`
-- carries a creator column. Those values arrive when the control plane publishes
-- an owner onto the agent snapshot; declaring them now would put classes in the
-- taxonomy that nothing can emit and report coverage buckets that are
-- structurally always zero.

ALTER TABLE invocations
  ADD COLUMN IF NOT EXISTS accountable_user_id TEXT,
  ADD COLUMN IF NOT EXISTS attribution_source  TEXT;

-- Backfill BEFORE the constraint is validated, because every historical row that
-- carries an originator violates the invariant on its face: accountable_user_id
-- is NULL while triggered_by_user_id is not. The fill is not a guess — the
-- invariant itself says what the answer has to be, and the source follows the
-- same rule the resolver applies to new rows (a child with a parent inherited
-- its human; anything else acted directly).
--
-- Rows with no originator are left entirely alone. NULL/NULL is a pre-357 row
-- that predates the question, and writing 'unattributed' across them would erase
-- the difference between "we asked and there was nobody" and "we never asked".
UPDATE invocations
   SET accountable_user_id = triggered_by_user_id,
       attribution_source  = CASE
                               WHEN parent_invocation_id IS NOT NULL THEN 'delegation'
                               ELSE 'direct_human'
                             END
 WHERE triggered_by_user_id IS NOT NULL
   AND accountable_user_id IS NULL;

-- One-way: originator present ⇒ accountable IS the originator.
--
-- Validated on creation rather than added NOT VALID and validated after.
-- node-pg-migrate wraps each migration file in a transaction (see migration
-- 349), so the ACCESS EXCLUSIVE lock taken by ADD CONSTRAINT is held until
-- commit either way — the two-step form would buy no lock relief here and would
-- only obscure that. A constraint left unvalidated is the thing to avoid: it
-- would police new rows while quietly tolerating every older row that already
-- broke the rule, which is exactly the half-enforcement this invariant cannot
-- afford. The backfill above is what lets the scan pass.
--
-- The scan is bounded by one tenant's invocations, which is the unit these
-- databases are sized in.
ALTER TABLE invocations
  DROP CONSTRAINT IF EXISTS invocations_accountable_follows_originator;
ALTER TABLE invocations
  ADD CONSTRAINT invocations_accountable_follows_originator
  CHECK (
    triggered_by_user_id IS NULL
    OR accountable_user_id IS NOT DISTINCT FROM triggered_by_user_id
  );

-- The model's other half, which until now was stated in prose only: the source
-- and the id have to agree. 'unattributed' means nobody was identified, so an id
-- alongside it is a contradiction; any other source names someone, so a NULL id
-- alongside it is a different contradiction. Both are the kind of drift that a
-- later derivation gets wrong once and then nobody notices, because every query
-- reading accountable_user_id would simply return fewer rows than it should.
--
-- The source VALUES are deliberately NOT enumerated in a CHECK, following
-- failure_class (migration 308): a new class should be a code change, not a
-- migration. What is constrained here is the relationship, which is what makes
-- the column trustworthy to read on its own.
--
-- NULL source is permitted for rows written before this migration.
ALTER TABLE invocations
  DROP CONSTRAINT IF EXISTS invocations_attribution_source_matches_id;
ALTER TABLE invocations
  ADD CONSTRAINT invocations_attribution_source_matches_id
  CHECK (
    attribution_source IS NULL
    OR (attribution_source = 'unattributed') = (accountable_user_id IS NULL)
  );

-- The queries this exists for: "everything this person is accountable for",
-- and the coverage split between precise and derived attribution.
CREATE INDEX IF NOT EXISTS idx_invocations_accountable_user
  ON invocations (tenant_id, accountable_user_id)
  WHERE accountable_user_id IS NOT NULL;

COMMENT ON COLUMN invocations.accountable_user_id IS
  'Whose run this is for budget, review-queue and escalation purposes. Equal to triggered_by_user_id whenever that is set (enforced by invocations_accountable_follows_originator, validated); otherwise NULL. Same value space as triggered_by_user_id: an accounts.id, or a slack:/teams: form for a channel sender with no account. Read attribution_source before trusting it as a statement about a person.';

COMMENT ON COLUMN invocations.attribution_source IS
  'How accountable_user_id was arrived at. direct_human = the person acted on this run themselves. delegation = inherited from the parent run of a delegated child. Both are PRECISE. unattributed = no human could be identified, and accountable_user_id is NULL; that is DEGRADED, and the coverage metric (invocation_attribution_total) reports the split. NULL only on rows written before this migration that carried no originator. Owner-derived sources (schedule owner, reactive-rule owner, agent owner) are deliberately absent: the runtime holds no owner for any of the three, so a value for them could never be written. They belong here when the control plane publishes an owner onto the agent snapshot.';
