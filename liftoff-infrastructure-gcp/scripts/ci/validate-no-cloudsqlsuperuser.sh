#!/usr/bin/env bash
# Phase 0g — fails CI if any service connection string ships with
# `cloudsqlsuperuser`. Break-glass access goes through the documented
# runbook, not via hard-coded connection strings.
#
# Ignores SQL comments (lines starting with `--`), shell/HCL comments
# (`#`), and explicit REVOKE / DROP USER statements (where mentioning
# the role IS the point).
set -euo pipefail

FAIL=0
PATTERN='cloudsqlsuperuser|cloudsql_superuser|cloudsqlsuperadmin'

for root in "$@"; do
  [ -d "$root" ] || continue
  matches=$(grep -rEn "$PATTERN" "$root" \
    --exclude-dir='.terraform' \
    --exclude-dir='node_modules' \
    --exclude-dir='.git' \
    --exclude-dir='dist' \
    --exclude='*.tgz' 2>/dev/null || true)
  [ -z "$matches" ] && continue

  # Filter out:
  #   - SQL comments (` -- ` or leading `--`)
  #   - HCL/shell comments (leading `#`)
  #   - REVOKE / DROP / ALTER ROLE ... RENAME statements
  #   - The audit script itself
  filtered=$(echo "$matches" | awk -F: '
    {
      # $1=file $2=line $3..=content
      content = ""
      for (i=3; i<=NF; i++) content = content (i>3?":":"") $i
      trimmed = content
      sub(/^[[:space:]]+/, "", trimmed)
      # Skip SQL + shell/HCL comments.
      if (trimmed ~ /^(--|#)/) next
      # Skip validator/audit files themselves.
      if ($1 ~ /validate-no-cloudsqlsuperuser\.sh$/) next
      if ($1 ~ /cloudsqlsuperuser-removal\.md$/) next
      # Skip explicit REVOKE / DROP / ALTER statements.
      upper = toupper(trimmed)
      if (upper ~ /^(REVOKE|DROP|ALTER|COMMENT ON)/) next
      print
    }')

  if [ -n "$filtered" ]; then
    echo "[validate-no-cloudsqlsuperuser] FAIL under $root:"
    # awk prefix avoids the SC2001 sed-can-be-parameter-expansion note;
    # sed 's/^/  /' is correct but shellcheck prefers built-in alternatives.
    echo "$filtered" | awk '{print "  " $0}'
    FAIL=$((FAIL + 1))
  fi
done

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
echo "[validate-no-cloudsqlsuperuser] OK — no cloudsqlsuperuser references in $*"
