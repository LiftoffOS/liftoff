#!/usr/bin/env bash
#
# CI fence: a migration that writes a FORCE-RLS table must drop FORCE first.
#
# The migrate job connects as liftoff_app, which has no BYPASSRLS. Under FORCE
# ROW LEVEL SECURITY the table's policy is evaluated even for the owner, and
# those policies read current_setting('app.current_tenant_id'), which a
# migration session never sets. The statement therefore RAISES rather than
# quietly matching nothing, and the whole migration rolls back and fails the
# build at the migrate step.
#
# This generalises system-agent-rls-fence.sh, which fired only when a write
# named a system agent by UUID or is_system, and only ever looked at
# internal_agents. A completely ordinary cross-tenant rewrite of
# internal_agents AND model_configs (migration 417, Grok moving to its own
# provider) needs the escape, matches neither condition, and fails the migrate
# step:
#
#     error: unrecognized configuration parameter "app.current_tenant_id"
#     > Rolling back attempted migration ...
#
# The rule here is the general one: any write to any FORCE-RLS table needs the
# escape, whatever it targets. The ALTER holds ACCESS EXCLUSIVE until COMMIT,
# so RLS is never observably off.
#
# The FORCE set is derived from the migrations themselves rather than a
# hand-kept list, so a table that gains FORCE later is covered without anybody
# remembering to update this script.
#
# Usage:
#   scripts/ci-fences/migration-force-rls-fence.sh [migrations-dir]
#
# Exit codes:
#   0 = clean
#   1 = a migration writes a FORCE-RLS table without dropping FORCE
#   2 = usage error

set -euo pipefail

DIR="${1:-migrations}"
if [[ ! -d "$DIR" ]]; then
  echo "migration-force-rls-fence: '$DIR' is not a directory" >&2
  exit 2
fi

# Migration 287 turned FORCE on. Anything at or below it executed before FORCE
# existed and has already applied; an applied migration never runs again, so it
# is not rewritable now.
FORCE_BOUNDARY=287

# Tables carrying FORCE ROW LEVEL SECURITY, read from eslint-rules/rls-tables.json.
#
# The database is the source, not the migrations. That is not a preference: the
# migrations declare 51 FORCE tables and the live database has 120. model_configs
# is the proof — it has carried FORCE for a long time and no migration in this
# repo ever says so, which is exactly why migration 417 could write it unguarded
# and reach the migrate step. rls-tables.json already made this call for
# relrowsecurity ("Source of truth is the database, not the migrations ... they
# cannot be trusted here"); forceTables rides the same generator and the same
# `npm run rls:tables` refresh.
TABLES_JSON="$(dirname "$0")/../../eslint-rules/rls-tables.json"
if [[ ! -f "$TABLES_JSON" ]]; then
  echo "migration-force-rls-fence: cannot find $TABLES_JSON" >&2
  exit 2
fi

forced_tables="$(node -e '
  const d = require(require("path").resolve(process.argv[1]));
  if (!Array.isArray(d.forceTables)) {
    console.error("rls-tables.json has no forceTables array — run: DATABASE_URL=<migrated-db> npm run rls:tables");
    process.exit(2);
  }
  process.stdout.write(d.forceTables.join("\n"));
' "$TABLES_JSON")"

if [[ -z "$forced_tables" ]]; then
  echo "migration-force-rls-fence: no FORCE-RLS tables found in '$DIR' — nothing to check"
  exit 0
fi

violations=0

# Each migration is scanned once for the tables it writes, then intersected with
# the FORCE set. The naive nesting was 410 files x 120 tables of grep and took
# 33s. `comm` rather than an associative array because macOS ships bash 3.2,
# where `declare -A` does not exist and the script would die on a developer
# laptop while passing in CI.
forced_sorted="$(sort -u <<<"$forced_tables")"

for file in "$DIR"/*.sql; do
  [[ -e "$file" ]] || continue

  base="$(basename "$file")"
  num="${base%%_*}"
  [[ "$num" =~ ^[0-9]+$ ]] || continue
  (( 10#$num <= FORCE_BOUNDARY )) && continue

  # Strip line comments: a table named in prose is not a write.
  body="$(sed 's/--.*$//' "$file")"

  # Every table this migration writes, whatever it is.
  written="$(
    grep -oiE '(UPDATE|INSERT[[:space:]]+INTO|DELETE[[:space:]]+FROM)[[:space:]]+[a-zA-Z_][a-zA-Z0-9_]*' <<<"$body" \
      | sed -E 's/.*[[:space:]]([a-zA-Z0-9_]+)$/\1/' \
      | tr 'A-Z' 'a-z' | sort -u
  )" || true

  # Only the tables that are both written here and FORCE-protected.
  offenders="$(comm -12 <(printf '%s\n' "$written") <(printf '%s\n' "$forced_sorted") 2>/dev/null || true)"

  while IFS= read -r table; do
    [[ -n "$table" ]] || continue

    if grep -qiE "ALTER[[:space:]]+TABLE[[:space:]]+${table}[[:space:]]+(NO[[:space:]]+FORCE|DISABLE)[[:space:]]+ROW[[:space:]]+LEVEL[[:space:]]+SECURITY" <<<"$body"; then
      continue
    fi

    echo "FAIL  $base"
    echo "      writes ${table}, which carries FORCE ROW LEVEL SECURITY, without dropping FORCE."
    echo "      The migrate job runs as liftoff_app (no BYPASSRLS), so the policy is evaluated and"
    echo "      current_setting('app.current_tenant_id') is unset in a migration session: the statement"
    echo "      raises and the migration rolls back. Wrap the write:"
    echo ""
    echo "          ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY;"
    echo "          <your UPDATE/INSERT/DELETE>"
    echo "          ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;"
    echo ""
    violations=$((violations + 1))
  done <<<"$offenders"
done

if [[ $violations -gt 0 ]]; then
  echo "migration-force-rls-fence: $violations write(s) would fail at the migrate step (see above)." >&2
  exit 1
fi

echo "migration-force-rls-fence: clean"
