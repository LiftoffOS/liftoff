# Migration Tools

| Script | Description |
|--------|-------------|
| `backfill.ts` | Bulk-copies `workforce_plans` rows from the platform-backend DB (`PG_SOURCE_URL`) into the workforce-service DB (`PG_TARGET_URL`) using cursor-paginated batches; supports `DRY_RUN=true`. |
| `setup-logical-replication.ts` | Creates a Postgres publication and logical replication slot on the source DB and prints the `CREATE SUBSCRIPTION` SQL to run on the target DB for live CDC during the cut-over window. |
