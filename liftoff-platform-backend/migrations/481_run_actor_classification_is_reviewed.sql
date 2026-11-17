-- Migration 481: the apify:run_actor classification row carries the review it was given.
--
-- Migration 454 inserted the row for the one platform-funded actor-run
-- capability with is_manual_override = true: a person reviewed it and stated
-- the class (a read, no categories). Its ON CONFLICT ... DO UPDATE refreshed
-- categories, the description hash and reviewed_by, but not the flag, so on
-- every database where a run_actor row already existed the review landed
-- without its mark: reviewed_by says 'manual-apify-run-actor' and
-- is_manual_override says false.
--
-- The capability chain admits a store actor as an automatic read-class
-- fallback only when this row is a reviewed, category-less classification
-- (capabilityIsAffirmativeRead in capability-discovery/vendor-execution.ts).
-- With the flag false, a store-actor handle walks no tail and no store actor
-- sits in any other candidate's tail, so a parked or failing vendor never
-- hands off to or from the store. This sets the mark the review already
-- carries. Idempotent; scoped to the one global row 454 wrote.
--
-- tool_classification_cache is not row-level secured; a plain UPDATE applies.

UPDATE tool_classification_cache
   SET is_manual_override = true
 WHERE tool_name = 'run_actor'
   AND integration_type = 'apify'
   AND tenant_id IS NULL
   AND reviewed_by = 'manual-apify-run-actor'
   AND cardinality(categories) = 0
   AND is_manual_override = false;
