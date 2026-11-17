# memory-eval — offline ranker harness

Replays historical retrievals from `memory_retrieval_events` against
alternate `RankingWeights` configurations and reports
Recall@5/@10, MRR, NDCG@10 per candidate + per tenant.

## Gold signal

The `cited_ids` column on `memory_retrieval_events` — populated by
`agent-execution/service.ts` and `interactive-chat/chat-turn-handler.ts`
when an agent's response references a retrieved memory id. That's the
binary relevance label.

Pre-migration-261 rows have `query_text IS NULL` and are skipped.

## Running

The harness runs as a Cloud Run Job against a tenant's runtime DB.
The pattern is the one in `liftoff-platform-backend/docs/operations.md`,
"Pattern for a TypeScript script in this repo".

```bash
gcloud run jobs create memory-eval \
  --image=us-west1-docker.pkg.dev/.../tenant-runtime:<sha> \
  --region=us-west1 --project=YOUR_TENANT_PROJECT \
  --service-account=YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com \
  --set-cloudsql-instances=YOUR_TENANT_PROJECT:us-west1:YOUR_TENANT_PROJECT \
  --network=YOUR_TENANT_PROJECT --subnet=YOUR_TENANT_PROJECT --vpc-egress=private-ranges-only \
  --set-env-vars="DB_USER=tenant_app,DB_NAME=tenant_runtime,GCP_PROJECT_ID=YOUR_TENANT_PROJECT,GCP_LOCATION=us-west1,MEM_SKIP_DIM_BIND=1,NODE_ENV=production" \
  --set-secrets="DB_PASSWORD=tenant-db-password:latest" \
  --command=node \
  --args="dist/scripts/memory-eval/harness.js,--since,2026-05-25,--until,2026-06-08,--candidates,baseline,no-recency,no-influence-summary"

gcloud run jobs execute memory-eval --region=us-west1 --project=YOUR_TENANT_PROJECT --wait
gcloud run jobs delete memory-eval --region=us-west1 --project=YOUR_TENANT_PROJECT --quiet
```

## CLI flags

| Flag | Type | Default | Notes |
|---|---|---|---|
| `--since`  | ISO date  | required  | inclusive |
| `--until`  | ISO date  | required  | exclusive |
| `--candidates` | csv | `baseline`  | from `candidates.ts` |
| `--min-cited`  | int   | `1`         | drop events with fewer cites |
| `--per-tenant-min` | int | `200`     | tenants below this don't get per-tenant rows |
| `--tenants`    | csv UUIDs | (all) | restrict to specific tenants |
| `--limit`      | int   | 100k      | cap on event count |
| `--out`        | path  | stdout    | writes markdown report |

## Sanity checks

- Running with `--candidates baseline,baseline` should produce identical
  per-event scores for both runs.
- Running with `--candidates baseline,no-semantic` (force `wSemantic=0`)
  should collapse NDCG vs baseline.

## Caveats

- Embedding cost: each replay calls the real embedding API for HyDE +
  the query embed. At Gemini rates (~$0.15/M tokens × ~125 tokens/query)
  → ~$0.10 per 5000 events.
- Result is stochastic if anything in the retrieval path uses random
  ordering (it doesn't, but worth verifying when adding new candidates).
- Process-global env: replay mutates `process.env.MEM_WEIGHT_*` between
  events, sequentially. Do not parallelize candidates within a single
  Node process.
