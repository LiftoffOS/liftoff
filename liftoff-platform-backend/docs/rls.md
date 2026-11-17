# Row-Level Security (RLS) — how-to

> The rule is INV-PB-001 in invariants.md.
> The hard rules are docs/invariants.md. This file holds the detail.

## Row-Level Security (RLS) — FORCE-enforced; every DB query on a tenant table MUST be scoped

**Every one of the ~104 tenant-scoped tables is (being) `FORCE ROW LEVEL SECURITY`.** Treat RLS as a hard runtime gate, not defense-in-depth: the database REJECTS unscoped access. (Rollout status: all callsites are wrapped and the admin-pool credential is live; FORCE itself is being re-applied dev→prod after a first attempt — migration `287` — was rolled back to close a census gap. Migration `288` grants the admin role future-table access. Regardless of the exact enable/disable state on any given day, **write every query as if FORCE is on** — that is the invariant this repo maintains.) A raw `pool.query`/`getPool().query` on an RLS table throws under FORCE:

```
ERROR: unrecognized configuration parameter "app.current_tenant_id"
```

(the tenant-isolation policy uses `current_setting('app.current_tenant_id')` with NO silent-null default, so a missing scope fails loud, not silently-empty). **A single un-wrapped callsite = 500s in prod.**

### The only three ways to touch an RLS table

All three are exported from src/infrastructure/database.ts:

1. **`withTenantScope(tenantId, (client) => client.query(...))`** — request-scoped access, when you have a `tenantId`. Sets `app.current_tenant_id` for one transaction so the policy admits exactly that tenant's rows. This is the default for anything with a tenant in scope (repos, routers, per-tenant services, insights reads).
2. **`withAdminScope({ caller, reason }, (client) => client.query(...))`** — connects as the `liftoff_admin` BYPASSRLS role. For background workers, batch ingesters, cross-tenant/operator reads, the audit-log batch writer, and **pre-tenant-context auth lookups** (resolving which tenant a request belongs to before any scope exists). Restricted by the `no-restricted-imports` ESLint rule — **you must add your file to the `ignores` allow-list in eslint.config.mjs with a one-line justification**, or lint fails.
3. **`SELECT set_config('app.current_tenant_id', $1, true)`** as the FIRST statement after your own `BEGIN` — ONLY when the code manages its own `pool.connect()` transaction (advisory locks, `FOR UPDATE`, multi-statement atomicity). Do NOT wrap your own transaction in `withTenantScope` — it nests transactions and breaks the locking.

### Hard rules

- **NEVER** write raw `getPool().query` / `pool.query` / `pool.connect()` against an RLS-enabled table. Wrap it.
- **Classification rule of thumb:** method has `tenantId` in scope → `withTenantScope`; by-PK / list-all / background job / pre-tenant-context → `withAdminScope`; own transaction → `set_config`-in-tx.
- **Non-RLS (platform-global) tables stay on the default pool** — `accounts`, `plans`, `subscriptions`, `tenants`, `staff_roles`, `feature_flags`, `models`, `model_pricing`, `distillation_cache`, `tool_classification_cache`, `schema_migrations`, and the other tables excluded by migrations 095/200/286. Check against the live RLS set (`SELECT relname FROM pg_class WHERE relrowsecurity`) — do not guess.
- The admin pool connects as `liftoff_admin` (BYPASSRLS) via `DB_ADMIN_USER=liftoff_admin` (terraform) + the shared `control-plane-db-password` (liftoff_admin's DB password is provisioned equal to it). The startup probe logs `admin_pool_probe_ok` when wired correctly; `admin_pool_probe_warning` means `withAdminScope` is silently running as `liftoff_app` and will be filtered under FORCE.

### Adding a new tenant-scoped table

1. Enable RLS + the tenant-isolation policy (re-run the 095/200 DO-loop pattern in a new migration) AND add `ALTER TABLE <t> FORCE ROW LEVEL SECURITY`.
2. Wrap every caller in `withTenantScope` / `withAdminScope` / `set_config`-in-tx per the classification rule.
3. Add the table to `EXPECTED_RLS_TABLES` in migrations/__tests__/200_verification.integration.test.ts with a cross-tenant denial test.
4. **Content tables** (tables that legitimately hold global `tenant_id IS NULL` rows read in a non-admin context, like a shared cache): EXCLUDE from RLS entirely (`DISABLE ROW LEVEL SECURITY`, like `distillation_cache` / `tool_classification_cache`) — do not FORCE them, or the global-row reads break.

### Testing

Wrapping a repo BREAKS its existing unit tests: they `jest.mock('../../infrastructure/database')` exposing only `{ pool }`, so `withTenantScope`/`withAdminScope` become `undefined`. Fix the mock to provide both wrappers (route the callback to the same mock-query fn) AND swallow the `set_config` statement so ordered query sequences don't shift. Run the targeted suite for the file you changed.

**Cross-repo:** `liftoff-tenant-runtime` enforces the same model on its `memories` table via the `r5/memories-must-be-tenant-scoped` ESLint rule — treat any tenant-scoped table in any repo as RLS-forced.

---

