#!/usr/bin/env bash
# Phase 0l — every new-service module MUST reference its own KMS key.
# macOS ships bash 3.2; this avoids `declare -A` so it runs locally.
set -euo pipefail

ROOT="${1:-terraform/modules}"
FAIL=0

services="billing developer-proxy workforce-service"
expected_key_for() {
  case "$1" in
    billing)            echo "billing-key" ;;
    developer-proxy)    echo "developer-proxy-key" ;;
    workforce-service)  echo "workforce-key" ;;
    *)                  echo "" ;;
  esac
}

for mod in $services; do
  dir="$ROOT/$mod"
  key="$(expected_key_for "$mod")"
  if [ ! -d "$dir" ]; then
    echo "[validate-kms-key-ref] FAIL: module directory missing: $dir"
    FAIL=$((FAIL + 1))
    continue
  fi
  if ! grep -r --include='*.tf' -l "$key" "$dir" >/dev/null 2>&1; then
    echo "[validate-kms-key-ref] FAIL: $dir does not reference its own KMS key '$key'"
    FAIL=$((FAIL + 1))
    continue
  fi
  for other in $services; do
    [ "$other" = "$mod" ] && continue
    other_key="$(expected_key_for "$other")"
    if grep -r --include='*.tf' -l "$other_key" "$dir" >/dev/null 2>&1; then
      echo "[validate-kms-key-ref] FAIL: $dir references ${other}'s key '$other_key'"
      FAIL=$((FAIL + 1))
    fi
  done
done

if [ "$FAIL" -gt 0 ]; then
  echo "[validate-kms-key-ref] $FAIL violation(s)"
  exit 1
fi
echo "[validate-kms-key-ref] OK — every service module references its own KMS key and no other's"
