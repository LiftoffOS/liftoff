# @liftoffos/database

Shared Postgres connection + tenant-isolation helpers used by every
Liftoff platform service.

## RLS contract (Phase 0h)

Every RPC handler in every new service must acquire its database
connection through `withTenantContext`. The helper opens a transaction,
binds the RLS variable `app.current_tenant_id` via `SET LOCAL`, and
hands the pooled client to the callback. Row-level security policies
read the same variable with `current_setting('app.current_tenant_id',
false)` — the `false` flag means a missing binding is a hard error, not
a silent empty result.

```ts
import { withTenantContext } from '@liftoffos/database';

await withTenantContext(pool, tenantId, async (client) => {
  const { rows } = await client.query('SELECT * FROM invoices');
  return rows;
});
```

### Static enforcement

`runRlsFence(root)` (exported from `@liftoffos/database`) walks a source
tree and flags any `pool.query(...)` / `client.query(...)` call not
lexically inside a `withTenantContext` / `withTenantScope` /
`withAdminScope` block. Files that begin with or contain the line
`// rls-fence: allow` are skipped — reserved for reconciliation jobs
and operator tooling.

CI wiring (each service):

```jsonc
// package.json
"scripts": {
  "lint:rls": "node -e \"const {runRlsFence}=require('@liftoffos/database'); runRlsFence('src').then(v=>{if(v.length){console.error(v);process.exit(1)}})\""
}
```

The fence is the compile-time complement to the RLS policies — together
they catch "I forgot to set the tenant" before it becomes a confused-
deputy production bug.

## Other exports

- `withTenantScope(pool, tenantId, { rlsVariableName }, fn)` — the
  lower-level helper. `withTenantContext` is a thin wrapper pinning
  `app.current_tenant_id`.
- `withAdminScope(pool, options, fn)` — operator-role scope with
  pgaudit bookkeeping. Use only from reconciliation jobs.
- `DatabasePoolFactory` — standard pool construction with CMEK-aware
  connection strings and pool-stats telemetry.
