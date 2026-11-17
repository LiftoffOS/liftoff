#!/usr/bin/env bash
# Phase 0d — validate that no NEW-service SA holds an unconditional
# `roles/secretmanager.secretAccessor` binding. Every such binding in
# the four new service modules MUST carry an IAM Condition pinning
# `resource.name.startsWith("projects/<proj>/secrets/<svc>-...")`.
#
# Scope: the four new service modules from Phase 0 plus any new module
# added in Phase 1+. Pre-existing modules (iam, governance-engine,
# connector-service, etc.) are NOT retroactively gated — they have
# their own pre-existing bindings and fixing them is out-of-scope for
# Phase 0. Add their path back here once they're brought into
# compliance (tracked as tech-debt).
#
# Override scope with args: each arg is a directory to validate.
# Default scope is the three new service modules + binauthz-admission.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  scope=(
    "terraform/modules/billing"
    "terraform/modules/developer-proxy"
    "terraform/modules/workforce-service"
    "terraform/modules/binauthz-admission"
  )
else
  scope=("$@")
fi

FAIL=0

for root in "${scope[@]}"; do
  [ -d "$root" ] || continue
  matches=$(grep -rEln 'roles/secretmanager\.secretAccessor' "$root" \
    --include='*.tf' --include='*.tf.json' 2>/dev/null || true)
  [ -z "$matches" ] && continue

  while IFS= read -r file; do
    while IFS= read -r line_no; do
      start=$((line_no > 40 ? line_no - 40 : 1))
      end=$((line_no + 40))
      block=$(sed -n "${start},${end}p" "$file")
      if echo "$block" | grep -qE '^\s*condition\s*\{'; then
        continue
      fi
      if echo "$block" | grep -qE '# secret-accessor-unconditional-allow'; then
        continue
      fi
      echo "[validate-secret-accessor] FAIL: $file:$line_no — unconditional roles/secretmanager.secretAccessor"
      FAIL=$((FAIL + 1))
    done < <(grep -n 'roles/secretmanager\.secretAccessor' "$file" | cut -d: -f1)
  done <<< "$matches"
done

if [ "$FAIL" -gt 0 ]; then
  echo "[validate-secret-accessor] $FAIL violation(s) in Phase 0+ service modules. Pin every binding with an IAM Condition."
  exit 1
fi
echo "[validate-secret-accessor] OK — all new-service secretAccessor bindings are conditional"
