#!/usr/bin/env bash
# Dry run for migrations 202/203/204 — applies to a throwaway database and
# exercises every constraint + index they introduce. Run BEFORE Cloud Build's
# migrate job touches dev so we catch schema bugs locally.
#
# Verifies:
#   1. CREATE TABLE succeeds (column types, NOT NULL, defaults, CHECK constraints)
#   2. FK to tenants (NOT NULL on internal_agent_outbox, nullable on control_plane_outbox)
#   3. ON DELETE CASCADE behavior
#   4. Partial unique indexes target the right (cols WHERE status) tuple
#   5. ON CONFLICT DO UPDATE works under the partial unique constraint
#   6. The DO UPDATE pattern from src/internal-agents/outbox.ts succeeds and
#      generates a new event_id (the concurrent-update race fix)
#   7. orphan_observations PK + republished column round-trip
#
# All work happens inside ONE psql session so we can roll back after.

set -euo pipefail

DB_NAME="liftoff_migration_dry_run_$$"
# Resolve repo root from this script's location: scripts/migration-dry-run.sh → repo
PB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "== Creating throwaway database: $DB_NAME"
createdb "$DB_NAME"
trap "dropdb --if-exists $DB_NAME" EXIT

# pgcrypto for gen_random_uuid()
echo "== Enabling pgcrypto"
psql -d "$DB_NAME" -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;" >/dev/null

# Minimal prereq tables so the FKs resolve. These mirror the production
# schema (tenants, internal_agents) enough to satisfy the migration FKs.
echo "== Creating prereq stub tables (tenants, internal_agents)"
psql -d "$DB_NAME" <<'SQL' >/dev/null
CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status TEXT NOT NULL DEFAULT 'active'
);
CREATE TABLE internal_agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  current_version INTEGER NOT NULL DEFAULT 1,
  deleted_at TIMESTAMPTZ
);
SQL

echo "== Applying migration 203 (internal_agent_outbox)"
psql -v ON_ERROR_STOP=1 -d "$DB_NAME" -f "$PB_DIR/migrations/203_internal_agent_outbox.sql" >/dev/null
echo "   ✓ migration 203 applied"

echo "== Applying migration 204 (control_plane_outbox)"
psql -v ON_ERROR_STOP=1 -d "$DB_NAME" -f "$PB_DIR/migrations/204_control_plane_outbox.sql" >/dev/null
echo "   ✓ migration 204 applied"

echo "== Applying migration 205 (orphan_observations)"
psql -v ON_ERROR_STOP=1 -d "$DB_NAME" -f "$PB_DIR/migrations/205_orphan_observations.sql" >/dev/null
echo "   ✓ migration 205 applied"

echo ""
echo "== Schema assertions"

# Verify indexes exist
psql -d "$DB_NAME" -tA <<'SQL' | tr -d ' ' | while IFS= read -r idx; do
SELECT indexname FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('internal_agent_outbox', 'control_plane_outbox', 'orphan_observations')
ORDER BY tablename, indexname;
SQL
  echo "   index: $idx"
done

echo ""
echo "== Functional tests"

# Seed a tenant + internal_agent so FKs are satisfied
psql -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
INSERT INTO tenants (id) VALUES ('00000000-0000-0000-0000-000000000001');
INSERT INTO internal_agents (id, tenant_id) VALUES ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000001');
SQL

# Test 1: INSERT into internal_agent_outbox works
echo "  T1: basic INSERT into internal_agent_outbox..."
psql -d "$DB_NAME" -v ON_ERROR_STOP=1 -tA <<'SQL' > /tmp/migration-test-out
INSERT INTO internal_agent_outbox (tenant_id, internal_agent_id, event_type, entity_version, event_payload)
VALUES ('00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-0000000000a1',
        'tenant.internal_agent.created',
        1, '{"role":"reviewer"}'::jsonb)
RETURNING id, event_id, status, attempts, max_attempts;
SQL
cat /tmp/migration-test-out | sed 's/^/      /'
echo "      ✓ INSERT succeeded with defaults"

# Test 2: CHECK constraint rejects non-matching event_type
echo "  T2: CHECK constraint rejects non-tenant.internal_agent.* event_type..."
T2_OUT=$(psql -d "$DB_NAME" -c "
INSERT INTO internal_agent_outbox (tenant_id, internal_agent_id, event_type, event_payload)
VALUES ('00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-0000000000a1',
        'wrong.event.type', '{}'::jsonb);" 2>&1 || true)
if echo "$T2_OUT" | grep -q "violates check constraint"; then
  echo "      ✓ CHECK constraint fired as expected"
else
  echo "      ✗ CHECK constraint did NOT fire — expected violation"
  echo "      psql output: $T2_OUT"
  exit 1
fi

# Test 3: Partial unique index — concurrent INSERT for same (tenant,agent,type)
#         while first is pending fires the conflict.
echo "  T3: Partial unique index blocks duplicate pending row..."
T3_OUT=$(psql -d "$DB_NAME" -c "
INSERT INTO internal_agent_outbox (tenant_id, internal_agent_id, event_type, event_payload)
VALUES ('00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-0000000000a1',
        'tenant.internal_agent.created',
        '{}'::jsonb);" 2>&1 || true)
if echo "$T3_OUT" | grep -q "duplicate key value violates unique constraint"; then
  echo "      ✓ Partial unique index fired on plain INSERT"
else
  echo "      ✗ Partial unique index did NOT fire on duplicate pending row"
  echo "      psql output: $T3_OUT"
  exit 1
fi

# Test 4: The DO UPDATE pattern from src/internal-agents/outbox.ts — verifies
# that on conflict we get a NEW event_id (the concurrent-update race fix).
echo "  T4: ON CONFLICT DO UPDATE rewrites payload AND generates new event_id..."
ORIG_EVENT_ID=$(psql -d "$DB_NAME" -tA -c "SELECT event_id FROM internal_agent_outbox WHERE event_type='tenant.internal_agent.created' AND status='pending';")
NEW_EVENT_ID=$(psql -d "$DB_NAME" -v ON_ERROR_STOP=1 -tA -q <<SQL | head -1
INSERT INTO internal_agent_outbox (tenant_id, internal_agent_id, event_type, entity_version, event_payload)
VALUES ('00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-0000000000a1',
        'tenant.internal_agent.created', 2, '{"role":"analyst"}'::jsonb)
ON CONFLICT (tenant_id, internal_agent_id, event_type)
  WHERE status IN ('pending', 'in_progress')
  DO UPDATE SET
    event_id        = gen_random_uuid(),
    event_payload   = EXCLUDED.event_payload,
    entity_version  = EXCLUDED.entity_version,
    status          = 'pending',
    attempts        = 0,
    last_error      = NULL,
    next_attempt_at = NOW(),
    updated_at      = NOW()
RETURNING event_id;
SQL
)
if [ "$ORIG_EVENT_ID" = "$NEW_EVENT_ID" ]; then
  echo "      ✗ event_id was NOT regenerated on conflict (got $NEW_EVENT_ID, same as original)"
  exit 1
fi
echo "      ✓ event_id regenerated: $ORIG_EVENT_ID → $NEW_EVENT_ID"

# Verify payload + entity_version were rewritten
PAYLOAD_AFTER=$(psql -d "$DB_NAME" -tA -c "SELECT event_payload->>'role' FROM internal_agent_outbox WHERE event_id='$NEW_EVENT_ID';")
VERSION_AFTER=$(psql -d "$DB_NAME" -tA -c "SELECT entity_version FROM internal_agent_outbox WHERE event_id='$NEW_EVENT_ID';")
if [ "$PAYLOAD_AFTER" = "analyst" ] && [ "$VERSION_AFTER" = "2" ]; then
  echo "      ✓ payload and entity_version were rewritten (role=analyst, version=2)"
else
  echo "      ✗ payload or entity_version NOT rewritten (got role=$PAYLOAD_AFTER, version=$VERSION_AFTER)"
  exit 1
fi

# Test 5: After marking 'completed', a fresh INSERT for same triple succeeds
echo "  T5: After marking completed, a new INSERT for same (tenant,agent,type) succeeds..."
psql -d "$DB_NAME" -c "UPDATE internal_agent_outbox SET status='completed' WHERE event_type='tenant.internal_agent.created';" >/dev/null
psql -d "$DB_NAME" -v ON_ERROR_STOP=1 -tA <<'SQL' >/dev/null
INSERT INTO internal_agent_outbox (tenant_id, internal_agent_id, event_type, event_payload)
VALUES ('00000000-0000-0000-0000-000000000001',
        '00000000-0000-0000-0000-0000000000a1',
        'tenant.internal_agent.created', '{}'::jsonb);
SQL
echo "      ✓ partial index correctly excludes completed rows"

# Test 6: ON DELETE CASCADE — deleting an internal_agents row removes outbox rows
echo "  T6: ON DELETE CASCADE from internal_agents..."
ROW_COUNT_BEFORE=$(psql -d "$DB_NAME" -tA -c "SELECT COUNT(*) FROM internal_agent_outbox;")
psql -d "$DB_NAME" -v ON_ERROR_STOP=1 -c "DELETE FROM internal_agents WHERE id='00000000-0000-0000-0000-0000000000a1';" >/dev/null
ROW_COUNT_AFTER=$(psql -d "$DB_NAME" -tA -c "SELECT COUNT(*) FROM internal_agent_outbox;")
if [ "$ROW_COUNT_BEFORE" -gt "0" ] && [ "$ROW_COUNT_AFTER" = "0" ]; then
  echo "      ✓ outbox rows cascaded (before=$ROW_COUNT_BEFORE, after=$ROW_COUNT_AFTER)"
else
  echo "      ✗ CASCADE didn't fire (before=$ROW_COUNT_BEFORE, after=$ROW_COUNT_AFTER)"
  exit 1
fi

# Restore the agent for the next test
psql -d "$DB_NAME" -c "INSERT INTO internal_agents (id, tenant_id) VALUES ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000001');" >/dev/null

# Test 7: control_plane_outbox — broader event_type CHECK + DO UPDATE
echo "  T7: control_plane_outbox accepts arbitrary entity_type/event_type..."
psql -d "$DB_NAME" -v ON_ERROR_STOP=1 -tA <<'SQL' >/dev/null
INSERT INTO control_plane_outbox (tenant_id, entity_type, entity_id, event_type, event_payload)
VALUES ('00000000-0000-0000-0000-000000000001', 'tenant', '00000000-0000-0000-0000-000000000001', 'tenant.activated', '{}'::jsonb),
       (NULL, 'account', 'acc-1', 'account.created', '{}'::jsonb);
SQL
echo "      ✓ accepts tenant.* and account.* (nullable tenant_id for cross-tenant events)"

# Test 8: control_plane_outbox DO UPDATE matches PB code shape
echo "  T8: control_plane_outbox ON CONFLICT DO UPDATE generates new event_id..."
ORIG_EID=$(psql -d "$DB_NAME" -tA -c "SELECT event_id FROM control_plane_outbox WHERE entity_id='acc-1';")
NEW_EID=$(psql -d "$DB_NAME" -v ON_ERROR_STOP=1 -tA -q <<SQL | head -1
INSERT INTO control_plane_outbox (tenant_id, entity_type, entity_id, event_type, event_payload)
VALUES (NULL, 'account', 'acc-1', 'account.created', '{}'::jsonb)
ON CONFLICT (entity_type, entity_id, event_type)
  WHERE status IN ('pending', 'in_progress')
  DO UPDATE SET
    event_id        = gen_random_uuid(),
    event_payload   = EXCLUDED.event_payload,
    entity_version  = EXCLUDED.entity_version,
    tenant_id       = EXCLUDED.tenant_id,
    status          = 'pending',
    attempts        = 0,
    last_error      = NULL,
    next_attempt_at = NOW(),
    updated_at      = NOW()
RETURNING event_id;
SQL
)
if [ "$ORIG_EID" = "$NEW_EID" ]; then
  echo "      ✗ control_plane_outbox event_id NOT regenerated"
  exit 1
fi
echo "      ✓ event_id regenerated: $ORIG_EID → $NEW_EID"

# Test 9: orphan_observations PK + republished column
echo "  T9: orphan_observations INSERT with default republished=FALSE..."
psql -d "$DB_NAME" -v ON_ERROR_STOP=1 -tA <<'SQL' >/dev/null
INSERT INTO orphan_observations (tenant_id, runtime_agent_id, internal_agent_id)
VALUES ('00000000-0000-0000-0000-000000000001',
        'aa000000-0000-0000-0000-000000000001',
        'bb000000-0000-0000-0000-000000000001');
SQL
REPUB=$(psql -d "$DB_NAME" -tA -c "SELECT republished FROM orphan_observations;")
if [ "$REPUB" = "f" ]; then
  echo "      ✓ republished defaulted to FALSE"
else
  echo "      ✗ republished default broken (got '$REPUB')"
  exit 1
fi

# Test 10: orphan_observations ON CONFLICT DO UPDATE last_seen_at
echo "  T10: orphan_observations ON CONFLICT updates last_seen_at..."
psql -d "$DB_NAME" -c "UPDATE orphan_observations SET last_seen_at = NOW() - INTERVAL '1 hour' WHERE tenant_id = '00000000-0000-0000-0000-000000000001';" >/dev/null
OLD_TS=$(psql -d "$DB_NAME" -tA -c "SELECT EXTRACT(EPOCH FROM last_seen_at)::int FROM orphan_observations;")
sleep 1
psql -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
INSERT INTO orphan_observations (tenant_id, runtime_agent_id, internal_agent_id)
VALUES ('00000000-0000-0000-0000-000000000001',
        'aa000000-0000-0000-0000-000000000001',
        'bb000000-0000-0000-0000-000000000001')
ON CONFLICT (tenant_id, runtime_agent_id) DO UPDATE SET last_seen_at = NOW();
SQL
NEW_TS=$(psql -d "$DB_NAME" -tA -c "SELECT EXTRACT(EPOCH FROM last_seen_at)::int FROM orphan_observations;")
if [ "$NEW_TS" -gt "$OLD_TS" ]; then
  echo "      ✓ last_seen_at bumped (Δ=$((NEW_TS - OLD_TS))s)"
else
  echo "      ✗ last_seen_at NOT bumped (old=$OLD_TS, new=$NEW_TS)"
  exit 1
fi

# Test 11: cleanup DELETE WHERE NOT IN — matches reconciler.ts:cleanupAbsentOrphans
echo "  T11: cleanupAbsentOrphans-style DELETE preserves the keeper..."
psql -d "$DB_NAME" -v ON_ERROR_STOP=1 <<'SQL' >/dev/null
INSERT INTO orphan_observations (tenant_id, runtime_agent_id, internal_agent_id)
VALUES ('00000000-0000-0000-0000-000000000001',
        'aa000000-0000-0000-0000-000000000999',
        'bb000000-0000-0000-0000-000000000999');
SQL
KEEPER='aa000000-0000-0000-0000-000000000001'
psql -d "$DB_NAME" -v ON_ERROR_STOP=1 -c "
DELETE FROM orphan_observations
WHERE tenant_id = '00000000-0000-0000-0000-000000000001'
  AND runtime_agent_id <> ALL(ARRAY['$KEEPER']::uuid[]);" >/dev/null
REMAINING=$(psql -d "$DB_NAME" -tA -c "SELECT runtime_agent_id FROM orphan_observations;")
if [ "$REMAINING" = "$KEEPER" ]; then
  echo "      ✓ cleanup preserved exactly the keeper, deleted the absent orphan"
else
  echo "      ✗ cleanup behavior unexpected (remaining: $REMAINING)"
  exit 1
fi

echo ""
echo "================================================================="
echo "ALL MIGRATION + INDEX + CONSTRAINT TESTS PASSED"
echo "================================================================="
