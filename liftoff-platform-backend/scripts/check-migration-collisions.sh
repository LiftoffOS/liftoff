#!/usr/bin/env bash
# Fail CI if two migrations share the same NNN prefix.
#
# Exclusions:
#   - Files matching *_rollback.sql are excluded (rollback artifacts, not forward migrations).
#   - Historical collisions listed in HISTORICAL_COLLISIONS are grandfathered.
#     See migrations/README.md for the rationale.
set -euo pipefail

MIGRATIONS_DIR="${1:-migrations}"

# Historical collisions that have already been applied to deployed databases.
# These are grandfathered — do NOT add new entries here.
HISTORICAL_COLLISIONS=("059" "074")

if [ ! -d "$MIGRATIONS_DIR" ]; then
  echo "No migrations directory at $MIGRATIONS_DIR — skipping"
  exit 0
fi

# Extract NNN prefixes from forward migrations only
duplicates=$(
  ls "$MIGRATIONS_DIR" \
    | grep -E '^[0-9]{3}_.*\.sql$' \
    | grep -v '_rollback\.sql$' \
    | sed -E 's/^([0-9]{3})_.*$/\1/' \
    | sort \
    | uniq -d
)

if [ -z "$duplicates" ]; then
  echo "Migration collision check passed."
  exit 0
fi

# Filter out historical collisions
new_collisions=""
for prefix in $duplicates; do
  is_historical=false
  for hist in "${HISTORICAL_COLLISIONS[@]}"; do
    if [ "$prefix" = "$hist" ]; then
      is_historical=true
      break
    fi
  done
  if [ "$is_historical" = false ]; then
    new_collisions="$new_collisions $prefix"
  fi
done

if [ -z "$new_collisions" ]; then
  echo "Migration collision check passed (only known historical collisions present)."
  exit 0
fi

echo "ERROR: New migration number collision detected:"
for prefix in $new_collisions; do
  echo "  $prefix:"
  ls "$MIGRATIONS_DIR" | grep "^${prefix}_" | sed 's/^/    /'
done
echo ""
echo "Each forward migration must have a unique NNN prefix."
echo "See migrations/README.md for naming convention."
exit 1
