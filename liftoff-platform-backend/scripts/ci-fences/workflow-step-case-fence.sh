#!/usr/bin/env bash
#
# Phase 0 CI fence: workflow-step-case
#
# Fails (or warns) if any .ts file references the deprecated snake_case
# WorkflowStep field names (step_id, tool_name, on_success, on_failure,
# tool_input). The canonical shape is camelCase everywhere.
#
# Phase 0-2: runs in WARN mode (tenant-runtime still has snake_case until
# Phase 3 renames it). At Phase 3, flip to FAIL mode.
#
# Usage:
#   scripts/ci-fences/workflow-step-case-fence.sh [path ...]

set -euo pipefail

MODE="${WORKFLOW_STEP_CASE_FENCE_MODE:-warn}"
ROOTS=("$@")
if [[ ${#ROOTS[@]} -eq 0 ]]; then
  ROOTS=("src" "packages")
fi

# Whitelist: this fence script, the plan file itself (if referenced),
# any migration file that mentions the rename.
WHITELIST_REGEX='(scripts/ci-fences/|migrations/|packages/contract-tests/|\.md$|__tests__/|\.test\.ts$|\.spec\.ts$)'

HITS_FILE="$(mktemp)"
trap "rm -f $HITS_FILE" EXIT

# Snake-case WorkflowStep field names to hunt for. Pattern is property-position
# (leading `.`, `{`, `,`, or leading whitespace; trailing `:`, `=`, `,`, `}`,
# `?`) to exclude SQL string contents. Many non-workflow files have legitimate
# DB-row mappings like `toolName: row.tool_name` — we exclude those by only
# scanning files that ACTUALLY reference WorkflowStep (by importing or
# declaring it).
SNAKE_PATTERN='([.{,]|^[[:space:]]+)[[:space:]]*(step_id|tool_name|tool_input|on_success|on_failure)[[:space:]]*[:?,=}]'

# Files that actually deal with WorkflowStep: import it, declare it, or
# reference the type by name. Only these files are in scope.
file_is_in_scope() {
  local f="$1"
  grep -lqE '(import[^;]*WorkflowStep|export[[:space:]]+(interface|type)[[:space:]]+WorkflowStep|:[[:space:]]*WorkflowStep\b|WorkflowStep\[\])' "$f" 2>/dev/null
}

for root in "${ROOTS[@]}"; do
  if [[ ! -e "$root" ]]; then
    continue
  fi
  while IFS= read -r file; do
    if echo "$file" | grep -qE "$WHITELIST_REGEX"; then
      continue
    fi
    # Only scan files that actually touch WorkflowStep.
    if ! file_is_in_scope "$file"; then
      continue
    fi
    grep -nE "$SNAKE_PATTERN" "$file" 2>/dev/null | while IFS= read -r line; do
      echo "$file:$line" >> "$HITS_FILE"
    done || true
  done < <(find "$root" -type f -name '*.ts' 2>/dev/null)
done

HIT_COUNT=$(wc -l < "$HITS_FILE" | tr -d ' ')

if [[ "$HIT_COUNT" -eq 0 ]]; then
  echo "workflow-step-case-fence: clean (mode=$MODE)"
  exit 0
fi

echo "workflow-step-case-fence: found $HIT_COUNT hits (mode=$MODE)" >&2
cat "$HITS_FILE" >&2

if [[ "$MODE" == "fail" ]]; then
  exit 1
fi
exit 0
