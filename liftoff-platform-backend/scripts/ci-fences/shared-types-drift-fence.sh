#!/usr/bin/env bash
#
# Phase 0 CI fence: shared-types-drift
#
# Fails if any source file in this repo declares a local TypeScript type
# that duplicates a shape already exported from @liftoffos/shared-types.
#
# This is a structural lint: looks for local `export interface AgentType`,
# `export type WorkflowStep`, etc., outside the shared-types package itself.
# A duplicate definition is a drift bug — the local type will eventually
# diverge from the canonical type and break cross-repo contracts.
#
# Usage:
#   scripts/ci-fences/shared-types-drift-fence.sh [path ...]

set -euo pipefail

MODE="${SHARED_TYPES_DRIFT_FENCE_MODE:-warn}"
ROOTS=("$@")
if [[ ${#ROOTS[@]} -eq 0 ]]; then
  ROOTS=("src")
fi

# Types exported from @liftoffos/shared-types that must NOT be duplicated
# in consumer code. Must match the exports in packages/shared-types/src/.
CANONICAL_TYPES=(
  "AgentType"
  "HitlLevel"
  "ModelConfig"
  "MemoryScope"
  "ExecConfig"
  "TriggerConfig"
  "WorkflowStep"
  "WorkflowStepLoop"
  "WorkflowStepRetry"
  "ConnectorFunction"
  "ToolCategory"
  "LLMTool"
  "ToolCatalogResponse"
  "TenantManifestsResponse"
  "ManifestSummary"
  "LLMWireRequest"
  "LLMWireResponseSchema"
  "LLMWireMessage"
  "DistillOutput"
  "DistillStage"
  "DistillProgressEvent"
  "DistillCompleteEvent"
  "DistillErrorEvent"
  "DistillErrorCode"
  "DistillStreamEvent"
  "InternalAgentCreatedPayload"
  "InternalAgentStatusChangedPayload"
  "InternalAgentRuntimeConfigUpdatedPayload"
  # What an event-triggered run's `input` carries. This service gates writes and
  # teaches the distiller from it; the Tenant Runtime BUILDS the object from the
  # same declaration. A local redefinition here would let the two disagree about
  # a field, which is exactly how `{{input.thread_id}}` came to be taught and
  # never supplied.
  "EventMessageEnvelope"
)

WHITELIST_REGEX='(packages/shared-types/|scripts/ci-fences/|\.d\.ts$|__tests__/|\.test\.ts$|\.spec\.ts$)'

HITS_FILE="$(mktemp)"
trap "rm -f $HITS_FILE" EXIT

# Build a grep alternation of the canonical type names.
TYPE_ALT=$(printf "|%s" "${CANONICAL_TYPES[@]}")
TYPE_ALT=${TYPE_ALT:1}
# Match `export interface <Name>` or `export type <Name>` declarations.
PATTERN="export (interface|type) (${TYPE_ALT})\b"

for root in "${ROOTS[@]}"; do
  if [[ ! -e "$root" ]]; then
    continue
  fi
  while IFS= read -r file; do
    if echo "$file" | grep -qE "$WHITELIST_REGEX"; then
      continue
    fi
    grep -nE "$PATTERN" "$file" 2>/dev/null | while IFS= read -r line; do
      echo "$file:$line" >> "$HITS_FILE"
    done || true
  done < <(find "$root" -type f -name '*.ts' 2>/dev/null)
done

HIT_COUNT=$(wc -l < "$HITS_FILE" | tr -d ' ')

if [[ "$HIT_COUNT" -eq 0 ]]; then
  echo "shared-types-drift-fence: clean (mode=$MODE)"
  exit 0
fi

echo "shared-types-drift-fence: found $HIT_COUNT local duplicates of canonical types (mode=$MODE)" >&2
cat "$HITS_FILE" >&2
echo "" >&2
echo "Fix: import the type from '@liftoffos/shared-types' instead of redeclaring it locally." >&2

if [[ "$MODE" == "fail" ]]; then
  exit 1
fi
exit 0
