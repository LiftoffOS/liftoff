# Agent Performance-Understanding Harness

Evaluates **how our agents actually perform** — for users, end to end — and, when they
fail, **where** in the platform they break. It does **not** replace unit/integration tests;
it reconstructs real (or synthetically driven) agent runs and scores them.

## Scope — four agents, three runtimes

| Agent | Runtime | Reconstructed from |
|---|---|---|
| **User-created agents** | tenant-runtime hybrid loop | `CanonicalTrajectory` (GCS + `agent_trajectories` index; raw-table fallback) — evaluated **in tenant-runtime** via the `/api/internal/test-harness/harvest` endpoint |
| **CAIO** | workforce-service `runPlatformAgent` | `team_plan_messages` + PB `agent_audit_logs` (mapped into `CanonicalTrajectory`) |
| **HRBP** | workforce-service (Cloud Tasks/spec) | `hrbp_provisioning_runs`/`events` + `workforce_plans` |
| **Insights** | platform-backend chat loop | `insights_chat_messages` + `llm_usage_log` + `audit_log` |

**Discovery is automatic.** The passive harvest enumerates **every active agent** on the eval
tenant from the source-of-truth tables — user-created runs from `invocations`
(`parent_invocation_id IS NULL`, grouped by `agent_id`; the `agent_trajectories` sink index is a
quality-filtered sliver, NOT the inventory), CAIO/HRBP/Insights from their service DBs — and
harvests each. It is **not** pointed at a single configured agent id.

## What it measures (five dimensions)

- **Goal success** + **spec conformance** — LLM-judge (in-boundary, via the DeepEval evaluator
  service or the native Vertex judge). **Advisory** until calibrated (see below).
- **Trajectory & efficiency** — deterministic: tool-correctness vs the agent's **designed toolset**,
  step efficiency, loops, cost/latency.
- **Tool-argument correctness** — did the agent call tools with *good arguments*? A deterministic
  **schema-validity floor** (`analyze/critics/schema-validity.ts`) scores each call's args against
  the tool's captured `input_schema` (required present / type / enum / numeric range / date-time &
  format) with graded partial credit; plus an advisory **arg-appropriateness** LLM judge
  (`analyze/judge/arguments.ts`) — "were the argument VALUES right for the request?". Covers
  **user-created agents** (real schemas + args captured on the trajectory — the best-covered case)
  and the three system agents (schemas replicated in `toolset/index.ts`; HRBP recovers its real tool
  args from `agent_audit_logs` via the `threadId = run_id` correlation, else falls back to
  `inputs_reliable=false` → null). Reliability-gated: `null` (never a fabricated `0`) when tool
  inputs weren't reliably captured or no schema is available. Advisory-only (warn/info findings,
  never gates).
- **Failure localization** — deterministic **engine-invariant auditors** (per runtime) +
  **tool-conformance** + agentic **RCA** (MAST/TRAIL). The deterministic findings are the
  reliable signal; the LLM judge/RCA are advisory triage.

Outputs: per-agent **scorecards** + cross-run **failure-mode clusters**.

## How scoring stays honest (mode-awareness + reliability gating)

Real runs are messy — non-interactive, partially captured, or reconstructed from lossy raw tables.
The harness gates each signal on whether the underlying evidence can actually support it, so it
never fabricates a verdict:

- **Mode-aware judges.** Agents run interactive (human) AND non-interactive (cron/event/agent), and
  many runs have **no persisted conversation**. The goal/conformance judges score from the recorded
  `outcome` (success → met, escalated → partial, error → not) for any run that is non-interactive
  or whose objective had to be synthesized (`trajectory_meta.synthesized_objective`); only a run
  with a real persisted conversation gets the LLM judge. This avoids false zeros on tool-only and
  scheduled runs.
- **Reliable-set tool conformance.** `out_of_set` and the `toolCorrectness` metric only fire/score
  against a **reliably captured** toolset — the runtime-recorded `trajectory.tools`, or a system
  agent's hardcoded catalog. (The LLM API only lets a model call tools it was given, so `out_of_set`
  can never catch a real hallucination — only capture-incompleteness.) On a lossy raw-table
  reconstruction the set is marked unreliable: `out_of_set` downgrades to a non-gating coverage-gap
  note and `toolCorrectness` is **NULL**, never a fabricated `0.0`. Runtime-injected tools (Claude
  Agent SDK `claude_code` presets) and bound vendor-MCP servers (`mcp__<id>__*`) are treated as
  in-set.
- **Input-reliability gating (no false loops).** The `loop_detected` / `idempotency_double_exec`
  detectors (→ MAST-1.3) key off the `(name, input)` signature. When a run's tool inputs were not
  reliably captured (`trajectory_meta.inputs_reliable === false` — set by the raw-table
  reconstruction when inputs are mostly empty), an empty input collapses the signature to name-only
  and every same-name call looks identical. The detectors are **skipped** for such runs (one
  non-gating info note instead), so a high-frequency tool with distinct args is never mis-flagged as
  a loop. The count-based runaway cap still applies.
- **Recorder-sourced tool inputs.** When the trajectory sink is on, `invocations.tool_calls` is
  populated with the real tool name+input recovered from the recorder's canonical capture (the
  adapter's start→finish correlation drops them for SDK-executed tools), so post-fix runs carry
  reliable inputs and don't need the gate above.

## Runs ON-DEMAND only

**There is no Cloud Scheduler and no deploy-coupled trigger** — the `agent-diagnostics` Cloud Run
Job (in `YOUR_GCP_PROJECT<env>`) fires **only when you execute it**:

```bash
# Passive: evaluate recent REAL runs (read-only, no side effects)
gcloud run jobs execute agent-diagnostics \
  --project=YOUR_GCP_PROJECT<env> --region=us-west1 \
  --args="^@^--harvest@--agents@user-created,caio,hrbp,insights"

# Active canary: drive a synthetic run and evaluate it (side-effects on the eval tenant)
gcloud run jobs execute agent-diagnostics \
  --project=YOUR_GCP_PROJECT<env> --region=us-west1 \
  --args="^@^--run@--agents@user-created"

# Investigate ONE run (incl. RCA): --args="^@^--investigate@<run-key>@--agents@<agent>"
# Calibrate judges against a labeled set: --args="--calibrate"  (needs DIAGNOSTICS_LABELED_SET_PATH)
```

CLI entrypoint: [`src/scripts/agent-diagnostics.ts`](../scripts/agent-diagnostics.ts). Modes:
`--discover` | `--harvest` | `--run` | `--investigate <key>` | `--calibrate`, with `--agents a,b,c`.

## Where results go

- **BigQuery** dataset `agent_diagnostics` (external tables over GCS NDJSON): `scorecards`,
  `run_results`, `failure_clusters`. Arg-scoring adds `avgArgValidity`/`argAppropriatenessRate`
  (scorecards) and `argValidity`/`argAppropriatenessPass` (run_results) — the external-table schema
  lives in `platform-ci/main.tf`, so new columns need a schema add there to be queryable.
- **Cloud Logging** structured events: `canary_run_outcome{agent,outcome}` and
  `agent_health{agent,dimension,value,regressed}` where `dimension ∈ {goal, conformance, invariant,
  efficiency, arg_validity, arg_appropriateness}` (matched by log-based metrics/alerts).
- GCS NDJSON fallback in the trajectory bucket when the BigQuery client is unavailable.

## Configuration (job env, Terraform-owned)

`DIAGNOSTICS_EVAL_TENANT_ID`, `DIAGNOSTICS_TR_HARNESS_URL` (+ `DIAGNOSTICS_SERVICE_TOKEN`) for the
in-TR user-created harvest,
`DIAGNOSTICS_{WORKFORCE,INSIGHTS}_DB_URL` (read replicas), `DEEPEVAL_SERVICE_URL`,
`DIAGNOSTICS_JUDGE_PROVIDER`/`_TIER`. The active-driver endpoints
(`DIAGNOSTICS_{WORKFORCE,INSIGHTS}_BASE_URL` / `_ACCOUNT_ID`) are optional — unset means those
agents' active drivers skip non-gating. The per-agent `DIAGNOSTICS_{USER,CAIO,HRBP,INSIGHTS}_AGENT_ID`
vars are **optional/legacy** — passive harvest auto-discovers all active agents (see Scope), so they
only scope an explicit single-agent `--discover`/`--run`. Infra:
`terraform/projects/platform-ci/main.tf` (`google_cloud_run_v2_job.agent_diagnostics`) + the
`deepeval-evaluator` Cloud Run service.

## Status / caveats

- **In-boundary by design.** Everything runs in our GCP; the LLM judge is in-boundary (Vertex /
  the DeepEval service). No agent content leaves the boundary.
- **Trajectory sink is PII-redacted, so it is safe to enable in prod.** The GCS trajectory sink
  (`src/trajectories/sink.ts`) strips credentials + PII (email/phone/SSN/credit-card) via
  `content-sanitizer.redactSensitiveContent` before every write, so richer captured trajectories are
  safe to retain. Gated by `TRAJECTORY_SINK_ENABLED` (+ the per-tenant `trajectory_sink_enabled`
  flag). When off, harvest falls back to raw-table reconstruction (and the
  reliability gates above apply).
- **Judges are advisory** — there is no labeled dataset yet, so `--calibrate` has not been run and
  judge scores are not κ-calibrated. The **deterministic invariants** are the trustworthy signal.
- **Not a deploy gate.** It does not block or roll back deploys; run it on demand and read the
  scorecards / `run_results` in BigQuery.
