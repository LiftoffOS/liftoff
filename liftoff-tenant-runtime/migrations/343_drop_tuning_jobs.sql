-- Migration 343: drop tuning_jobs (migration 319).
--
-- The self-tuning flywheel is removed. `tuning_jobs` was the crash-safe job-state table for the
-- Vertex tuning launcher — find-or-create, fenced CAS claim, reconcile-before-create so a crash
-- between create and update adopted the existing provider job instead of paying for a second one.
-- Careful machinery for a pipeline that never launched a single job in any environment.
--
-- The launcher, the gate, the provider adapters and the SFT half of the dataset assembler are
-- deleted in the same change; platform-backend drops the registry and promotion ledger it fed
-- (PB migration 330). Of the seven vendors the product offers, only Google could be fine-tuned at
-- all, and Vertex tunes Gemini 2.5.x while we serve 3.x — so a tuned agent would have run a
-- generation behind its own untuned default.
--
-- What remains of the learning loop is preference recall: HITL approvals, chat corrections and
-- late-feedback flags become recallable 'preference' memories, which needs no training run and no
-- job state. Trajectory capture and `dataset_manifests` stay — the pairs assembler still writes
-- manifests.

DROP TABLE IF EXISTS tuning_jobs;
