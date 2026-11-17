-- The injection detector enforces: a block verdict now refuses, at the two
-- placements PLACEMENT_MAY_BLOCK allows (chat and persistence). Tool ingress
-- and the tenant runtime still refuse nothing, because that policy is code
-- rather than a flag and this migration does not touch it.
--
-- Migration 540 seeded this row false and put every tenant in shadow. Waiting
-- on shadow samples is a weak gate: a shadow sample only fires on a
-- would-block, so a low-traffic period produces almost nothing to review.
-- The stronger evidence is to replay the real detector over every population
-- this flag lets refuse (chat typed by a person, settled replies, structured
-- skills) and confirm none of it blocks against the 0.7 threshold.
--
-- The placement to watch is persistence. A model-authored assistant reply,
-- typically a connector-setup conversation (the benign class the guard's own
-- rubric was written to protect), can score close to the block line on
-- `exfiltrate.secrets` + `exfiltrate.credentials_with_intent`; such a reply
-- lands in `review`, which never blocks. So persistence carries far less
-- headroom than chat, and if a settled reply ever does cross the line,
-- `settle-turn-router` answers `{ persisted: false, blocked: true }` and the
-- team's final answer is not written to the thread. That is a visible failure
-- rather than a silent one, and it is the thing to watch first.
--
-- Written as a migration rather than an operator flip so the chain stays the
-- authority: a rebuilt environment answers the same as a long-running one, which is exactly
-- what a value owned by a migration and changed by something else stops being
-- true. Idempotent, and scoped so it cannot resurrect a row 540 never wrote.
UPDATE feature_flags
   SET enabled = true,
       updated_at = NOW()
 WHERE key = 'injection_detection_enforce'
   AND enabled IS DISTINCT FROM true;
