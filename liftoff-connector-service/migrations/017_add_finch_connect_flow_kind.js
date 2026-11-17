/**
 * Add 'finch_connect' to the auth_flow_kind enum.
 *
 * The Finch credential-store path
 * (`credentialService.storeCredentials(..., 'finch_connect', ...)`) inserts
 * `connector_credentials.flow_kind = 'finch_connect'`. That value was never
 * added to the `auth_flow_kind` enum (created in migration 001), so Finch
 * finalize failed at the INSERT with:
 *   invalid input value for enum auth_flow_kind: "finch_connect"  (HTTP 500)
 * The popup completed and relayed the code, but the vault INSERT was rejected —
 * so the connect UI hung (modal stuck, no success toast).
 *
 * This is a JS migration (not .sql) because `ALTER TYPE ... ADD VALUE` cannot
 * run inside a transaction when the enum was created in a PRIOR migration
 * (node-pg-migrate wraps migrations in a transaction by default). `pgm.noTransaction()`
 * is the documented way to run it outside the wrapping transaction. `IF NOT
 * EXISTS` keeps it idempotent/re-runnable.
 *
 * Only 'finch_connect' is added: composio_managed short-circuits storeCredentials
 * (Composio holds the tokens), and stackone_connect stores only connector config
 * (no connector_credentials row) — neither ever inserts a flow_kind.
 */

exports.up = (pgm) => {
  pgm.noTransaction();
  pgm.sql("ALTER TYPE auth_flow_kind ADD VALUE IF NOT EXISTS 'finch_connect';");
};

// Postgres cannot DROP an enum value; leaving it is harmless. No-op down.
exports.down = () => {};
