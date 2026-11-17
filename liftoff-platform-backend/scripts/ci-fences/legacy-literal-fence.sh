#!/usr/bin/env bash
#
# Phase 0 CI fence: legacy-literal
#
# Fails (or warns) if any non-migration, non-test .ts or .sql file contains
# a string literal 'A', 'B', or 'C' in the context of agent type.
#
# Phase 1c: default mode is now FAIL. Any legacy 'A'|'B'|'C' literal in
# an agent-type context fails the build. Override with
# LEGACY_LITERAL_FENCE_MODE=warn if temporarily needed.
#
# Usage:
#   scripts/ci-fences/legacy-literal-fence.sh [path ...]
#
# Exit codes:
#   0 = clean (or warn mode with hits)
#   1 = fail mode with hits
#   2 = usage error

set -euo pipefail

MODE="${LEGACY_LITERAL_FENCE_MODE:-fail}"
ROOTS=("$@")
if [[ ${#ROOTS[@]} -eq 0 ]]; then
  ROOTS=("src" "packages")
fi

# Whitelist patterns — allow legacy literals to appear in:
#   - migration files that mention them for data rewrites
#   - this fence script itself
#   - contract-test fixtures (they contain legacy literals as negative-test inputs)
#   - the shared-types legacy-migration notes
WHITELIST_REGEX='(migrations/|scripts/ci-fences/|packages/contract-tests/|packages/shared-types/src/agent\.ts|__tests__/|\.test\.ts$|\.spec\.ts$)'

# The pattern we're hunting: a quoted single-letter literal 'A'|'B'|'C' near
# the token "agent_type" or "agentType" within a small window. Using ripgrep
# via the standard grep-path approach.
#
# We look for lines containing agent_type|agentType and, on the same or
# adjacent line, the literal 'A'|'B'|'C'. For simplicity we flag lines that
# contain BOTH the identifier and one of the legacy literals.
HITS_FILE="$(mktemp)"
trap "rm -f $HITS_FILE" EXIT

for root in "${ROOTS[@]}"; do
  if [[ ! -e "$root" ]]; then
    continue
  fi
  # Find .ts and .sql files, then scan each for the pattern.
  while IFS= read -r file; do
    # Skip whitelisted paths
    if echo "$file" | grep -qE "$WHITELIST_REGEX"; then
      continue
    fi
    # Look for lines that reference agentType/agent_type AND a legacy literal
    awk '
      /agent_?[Tt]ype/ && /'\''[ABC]'\''/ {
        print FILENAME ":" NR ":" $0
      }
    ' "$file" >> "$HITS_FILE" || true
  done < <(find "$root" -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.sql' \) 2>/dev/null)
done

HIT_COUNT=$(wc -l < "$HITS_FILE" | tr -d ' ')

if [[ "$HIT_COUNT" -eq 0 ]]; then
  echo "legacy-literal-fence: clean (mode=$MODE)"
  exit 0
fi

echo "legacy-literal-fence: found $HIT_COUNT hits (mode=$MODE)" >&2
cat "$HITS_FILE" >&2

if [[ "$MODE" == "fail" ]]; then
  exit 1
fi
exit 0
