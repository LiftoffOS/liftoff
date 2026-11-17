-- Migration 344: drop the trajectory dataset manifests and their curation snapshots
-- (migration 318).
--
-- These existed to make TRAINING artifacts reproducible: a manifest reserved before selection so a
-- crash-retry re-emitted byte-identical content, and an immutable curation row freezing the
-- selection so two racing workers could not disagree about which rows a dataset contained. Real
-- care, for datasets nothing consumes.
--
-- Migration 343 removed the fine-tuning pipeline that read the `sft` artifacts. What was left were
-- the `preference_pairs` and `reward_records` artifacts, which are DPO and reward-model training
-- data — the same dead end one file over. Nothing in either plane ever read them back: the only
-- reader of dataset_manifests was the reservation helper checking whether it had already written
-- one.
--
-- The preference SIGNAL is not lost, because it never depended on any of this. `correction-capture`
-- writes a 'correction'-tagged memory the moment a human rejects a tool call — the specific calls,
-- the reason, a 180-day TTL — on the request path, with no batch job, no GCS object and no
-- manifest. That is the mechanism that makes an agent stop repeating a mistake. The assembler's
-- contribution on top was one generically-worded 'preference' memory per pair, up to seven days
-- later (label-settle watermark) and capped per run.
--
-- Kept and untouched: trajectory capture (agent_trajectories + the GCS trajectory bucket), which
-- is wired into agent-execution and every code-session runner and feeds diagnostics and
-- collab-sessions; correction-capture; the autonomy advisor; the skills flywheel.
--
-- Child first: dataset_manifest_curation FKs (manifest_id, tenant_id) → dataset_manifests.

DROP TABLE IF EXISTS dataset_manifest_curation;
DROP TABLE IF EXISTS dataset_manifests;
