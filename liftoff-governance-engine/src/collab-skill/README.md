# CollabSkill posterior store (shadow substrate)

Per-(tenant, entity) collaboration-skill estimates, disentangling agent, human,
and backbone contributions. Written only by the rollup job; read only by
`GET /api/governance/collab-skill`. Nothing consults it for enforcement.

## The updater contract (what the DS ships)

An updater is a **pure, stateless fold** — it always receives the full match set
in `(startedAt, sessionId)` order and returns the complete posterior map. It is
never handed persisted priors. This structurally guarantees idempotence: rerun
the rollup and the end state is identical.

```ts
interface SkillUpdater {
  readonly modelVersion: string;
  update(matches: MatchRecord[]): Map<string, SkillPosterior>;
}
```

To add a model (e.g. the additive Kalman `y = s_A + s_H + ε`):

1. Add `src/collab-skill/updaters/additive-kalman-v1.ts` exporting a `SkillUpdater`
   with a distinct `modelVersion`.
2. Register it in `updaters/registry.ts`.
3. Run the rollup with `--model-version additive-kalman-v1`. `model_version` is
   part of the unique key, so candidate models coexist without clobbering.

`posteriorKey` serialization is fixed: `` `${tenantId} ${entityType} ${entityId} ${scope}` ``.

## Export → rollup sequence

The rollup does NOT list GCS. A diagnostics-job pass (`--collab-export`) is the
only component that lists: it validates every session row, dedupes (live > backfill,
then `emitted_at`), joins grades, and publishes one immutable
`diagnostics/collab_matches/data-<runId>.ndjson` plus a checksummed
`latest.meta.json`. Run order each cycle:

```
# 1. diagnostics job (TR image), objectAdmin on the bucket:
gcloud run jobs execute agent-diagnostics --args="^@^--collab-export"
# 2. this job (governance-engine image), governance_app credential:
gcloud run jobs execute governance-engine-collab-rollup --args="^@^--run-id@r1"
```

The rollup GETs `latest.meta.json`, verifies sha256 + row_count + schema_version
(fail-closed), filters to `max(COLLAB_ROLLUP_EPOCH, now-350d)` (retention clamp,
logged when it binds), folds, then upserts + deletes stale rows for the
`model_version` inside one `pg_advisory_xact_lock`-guarded transaction.

## INVARIANT: owner-bypass credential

The rollup connects as `governance_app` — the table owner. GE RLS is `ENABLE`,
not `FORCE`, so the owner reads/writes every tenant's rows. **These tables must
not be switched to `FORCE` while this job exists.** If `FORCE` is ever required,
provision `governance_admin`'s password (migrate-password-sync pattern) and set
`DB_USER=governance_admin` first.

## Erasure

`--erase-tenant <tenantId>` deletes that tenant's posteriors. It is step 2 of the
runbook erasure sequence (TR objects → GE posteriors → re-export → re-rollup).

## Second supervision-label stream

Beyond HITL approvals, GE's `human_feedback` table (late feedback / corrections)
is a second human-supervision signal the DS may join in — not consumed here.
