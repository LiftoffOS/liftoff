# Deliverable grader

Reference-free scoring of a completed session's deliverable: generate a weighted
rubric, then score it with N mixed-model judges, producing one 0–100 per session.
Advisory only. User-created agents only (best capture fidelity). Runs in-TR inside
the `/harvest` path so GCS artifacts are readable.

## Bounded, incremental grading (`--collab-grade`)

Grading is NOT run inline in the full harvest. The full harvest is one synchronous
request that reconstructs + evaluates every discovered run; grading roughly doubles
per-run LLM cost and would exceed the request timeout at any real tenant scale.
Instead the `--collab-grade` job mode lists collab sessions with no grade object
yet (newest first), grades a bounded batch (`DIAGNOSTICS_GRADE_BATCH`, default 10)
via one single-run `/harvest` call each (fast — one reconstruct + rubric + judges),
and sinks the rubrics/grades. Repeated invocations drain the backlog; already-graded
sessions are skipped by the presence of `diagnostics/grades/<session_id>.ndjson`.

## Config (rides the /harvest body; no dedicated TR env)

- `DIAGNOSTICS_GRADE_BATCH` — max sessions graded per `--collab-grade` run
  (default 10); bounds the job's per-invocation LLM work.
- `DIAGNOSTICS_GRADER_JUDGES` — comma-separated `provider:tier` specs. Malformed
  entries are dropped, the list is deduped and capped at 4, and a blank value
  falls back to `anthropic:large,google:large` (mixed models counter
  self-preference bias). Never an empty judge set.
- `DIAGNOSTICS_RUBRIC_MODEL` — `provider:tier` for rubric generation (default
  `anthropic:large`). A retired tier name is still read as `large` (see `normalizeTier`).

## Determinism + reproducibility

- Rubric items carry stable ids (`c<catIdx>.i<itemIdx>`) minted at generation.
- Each judge must return exactly one finite result per stored id; a judge with a
  missing / duplicate / extra / non-finite result is dropped. `awarded` is clamped
  to the **rubric's** points, never the model's claimed max.
- Per category the subtotal is `Σawarded / Σpoints`; the judge total normalizes by
  the validated category-weight sum, so weight tolerance cannot skew the scale.
- `spread ≝ max(judge totals) − min(judge totals)`.
- Every grade row persists both prompt versions, each judge's resolved model id,
  and `effective_config_hash = sha1(rubric_prompt_version | score_prompt_version |
  rubric_resolved_model | ordered resolved judge models)`.

## Artifacts

Discovery is a GET of the session's `manifest.json` (never a bucket listing);
404/403 (no manifest / no read on a non-eval tenant) ⇒ trajectory-text-only
grading with `artifacts_present=false`. Each admitted URI is downloaded via a
bounded read stream with per-file (6k char) and aggregate (24k char) budgets, so
the 25 MB capture cap never becomes a 25 MB prompt.

## Calibration (`--calibrate-grader`)

Labeled set (local path or `gs://`), schema:

```json
[{ "session_id": "...", "tenant_id": "...", "agent_id": "...",
   "agent_kind": "user-created", "human_score": 78, "notes": "optional" }]
```

Grades are fetched from `diagnostics/grades/<session_id>.ndjson`; missing ones are
optionally regraded on demand (`--regrade-mismatches`). Reports are grouped into
cohorts by `effective_config_hash` (never mixing configs) and hold **aggregates
only** (Pearson r, Spearman ρ, MAE, mean spread, per-judge bias) — no
tenant/session identifiers. `n<2` or zero-variance statistics are null, not NaN.
Requires `--run-id` (→ `calibration_run_id`, so reports never overwrite).

The labeled-set FILE carries identifiers and therefore has its own tenant-erasure
step in the runbook (scrub the tenant's entries).
