# CollabSkill eval substrate — data flow

Advisory, shadow-mode telemetry for evaluating agent and human-supervised-agent
performance. Nothing here gates or changes product behavior.

## What leaves the tenant project

Both `COLLAB_SESSIONS_ENABLED` and `COLLAB_ARTIFACT_SNAPSHOT_ENABLED` are
**default-on for every tenant**: the deploy resolves each with a `true` default
(`get_flag` in `cloudbuild.yaml`), so every tenant redeploy and every
newly-provisioned tenant turns the emitter and artifact capture on unless a
tenant is explicitly opted out. `get_flag` reads the live pre-deploy revision, so
an explicit per-tenant `false` survives redeploys.

On each completed top-level run, when `COLLAB_SESSIONS_ENABLED=true`, the emitter
writes one NDJSON row to the control-project bucket
`gs://trajectories-<env>/diagnostics/collab_sessions/live/<invocationId>.ndjson`.
The row carries: agent id, the **triggering human's account id** (or `slack:`/
`teams:` channel id; null for autonomous runs), provider/model, outcome, cost,
token counts, and deterministic process-metrics (message/tool counts, human-message
timing). HITL counts are null on live rows and correlated only by backfill (via
`hitl_approval_requests.invocation_id`, migration 312). When
`COLLAB_ARTIFACT_SNAPSHOT_ENABLED=true`, redacted deliverable text is captured and
uploaded under `<tenantId>/artifacts/<invocationId>/` with a `manifest.json`.

## Emitter safety

Two-phase and fail-safe: Phase A synchronously captures all mutable state (recorder
messages, tool results, artifact contents) into an immutable payload before the
trajectory recorder buffer is released; Phase B persists from the copy under a
cancellation budget (destroyable pg/GCS streams, a semaphore bounding detached
work). It never throws into the run path and never blocks it beyond a small bound.

## Downstream (control project)

The diagnostics job grades deliverables (rubric + N mixed-model judges → 0–100),
consolidates sessions + grades into a single validated match export, and the
governance-engine rollup folds that into the `collab_skill` posterior store. The
data is exposed to analysis via BigQuery external tables (us-west1 dataset,
BigLake connection) and `GET /api/governance/collab-skill`.

**Grader mode** (`DIAGNOSTICS_GRADER_MODE`, `oneshot` default → `agentic`): the
one-shot judge reasons over truncated deliverable text. In `agentic` mode each
mixed-model judge (Claude Code / Gemini) instead runs as a bounded agent via the
vendor adapter with an **isolated sandbox** (file/shell tools dispatched to
`sandbox-executor`) and a catalog-scoped **read-only gate** — so a judge can
actively verify the real deliverable (materialized into its sandbox `/workspace`)
rather than skim its text. The gate denies escape/mutation tools (`code_session`,
`delegate_to_agent`, …). Same `GradeResult` contract; agentic **falls back to
one-shot** on any error / HITL pause / timeout, so a grading failure never fails
the harvest. `collab-grade-worker.ts` runs the execution-heavy agentic grades as
their own Cloud Run Job (past the diagnostics job's timeout).

## Scope + privacy

Default-on fleet-wide (per-tenant `false` opts out; see above). Identity fields
are the customer's own operators; capture-time redaction strips credentials + PII. Retention follows
the bucket's 365-day lifecycle; the skill window is retention-bounded. Full
data-flow / retention / erasure detail: `docs/compliance/ropa.md` (P4, in
platform-backend) and `docs/runbooks/COLLAB_SESSION_EROSION_AND_OPS.md`.
