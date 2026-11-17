#!/usr/bin/env bash
#
# CI fence: a migration that writes a system-agent row must drop FORCE RLS first.
#
# Platform-owned agents (CAIO, HRBP) are seeded with tenant_id IS NULL -- that is
# migration 193's CHECK, and it is what makes them platform-level rather than any
# one tenant's. internal_agents carries FORCE ROW LEVEL SECURITY (migration 287),
# and the migrate job connects as liftoff_app, which has no BYPASSRLS and is not
# a member of liftoff_admin. Both halves of the tenant policy then defeat the
# write: evaluating current_setting('app.current_tenant_id') with nothing set
# raises 42704 and aborts the migration, and even with the GUC set the statement
# matches zero rows, because NULL never equals a uuid.
#
# A migration that hits this fails the build at the migrate step, blocking
# every deploy behind it until it is rewritten to wrap the UPDATE in
# ALTER TABLE ... NO FORCE / FORCE ROW LEVEL SECURITY.
#
# So: any migration naming a system-agent UUID in a write must also carry the
# NO FORCE escape. The ALTER holds ACCESS EXCLUSIVE until COMMIT, so RLS is
# never observably off.
#
# Usage:
#   scripts/ci-fences/system-agent-rls-fence.sh [migrations-dir]
#
# Exit codes:
#   0 = clean
#   1 = a migration writes a system-agent row without dropping FORCE
#   2 = usage error

set -euo pipefail

DIR="${1:-migrations}"
if [[ ! -d "$DIR" ]]; then
  echo "system-agent-rls-fence: '$DIR' is not a directory" >&2
  exit 2
fi

# The seeded system agents (migration 194). Matched case-insensitively.
CAIO_ID='00000000-0000-0000-0000-000000000001'
HRBP_ID='00000000-0000-0000-0000-000000000002'

# Migration 287 turned on FORCE ROW LEVEL SECURITY. Anything numbered above it
# executes in a FORCE world and needs the escape; anything at or below it ran
# before FORCE existed and has already applied.
FORCE_BOUNDARY=287

violations=0

for file in "$DIR"/*.sql; do
  [[ -e "$file" ]] || continue

  # Strip line comments: a UUID mentioned in prose is not a write.
  body="$(sed 's/--.*$//' "$file")"

  # Does it write internal_agents at all?
  if ! grep -qiE '(UPDATE[[:space:]]+internal_agents|INSERT[[:space:]]+INTO[[:space:]]+internal_agents|DELETE[[:space:]]+FROM[[:space:]]+internal_agents)' <<<"$body"; then
    continue
  fi

  # Does that write target a system agent (by UUID, or by the is_system flag)?
  if ! grep -qiE "($CAIO_ID|$HRBP_ID|is_system[[:space:]]*=[[:space:]]*TRUE)" <<<"$body"; then
    continue
  fi

  # Migrations at or below FORCE_BOUNDARY ran before migration 287 turned FORCE
  # on, and an applied migration never runs again, so they were correct when
  # they executed and are not rewritable now. 193/194 (the system-agent seed)
  # and 199 (an HRBP prompt update) all sit below the line.
  base="$(basename "$file")"
  num="${base%%_*}"
  if [[ "$num" =~ ^[0-9]+$ ]] && (( 10#$num <= FORCE_BOUNDARY )); then
    continue
  fi

  if grep -qiE 'ALTER[[:space:]]+TABLE[[:space:]]+internal_agents[[:space:]]+(NO[[:space:]]+FORCE|DISABLE)[[:space:]]+ROW[[:space:]]+LEVEL[[:space:]]+SECURITY' <<<"$body"; then
    continue
  fi

  echo "FAIL  $file"
  echo "      writes a system-agent row (tenant_id IS NULL) but never drops FORCE row-level security."
  echo "      Under FORCE RLS as liftoff_app this raises 42704 and aborts the migration, failing the"
  echo "      build at the migrate step. Wrap the write:"
  echo ""
  echo "          ALTER TABLE internal_agents NO FORCE ROW LEVEL SECURITY;"
  echo "          <your UPDATE/INSERT>"
  echo "          ALTER TABLE internal_agents FORCE ROW LEVEL SECURITY;"
  echo ""
  violations=$((violations + 1))
done

if [[ $violations -gt 0 ]]; then
  echo "system-agent-rls-fence: $violations migration(s) would fail at the migrate step (see above)." >&2
  exit 1
fi

echo "system-agent-rls-fence: clean"
