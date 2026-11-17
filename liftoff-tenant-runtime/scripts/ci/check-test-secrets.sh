#!/usr/bin/env bash
# R5 TE-R5-005: detect test files containing real-looking secrets without the
# TESTONLY marker. Fails CI if found.
# Real-looking secrets trigger GitHub push protection / secret scanning;
# canonical test values must embed TESTONLY_NOTASECRET_ padding.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Patterns that resemble real secrets (canonical forms of our scrubber)
SUSPECT_PATTERNS=(
  'sk-ant-api0[0-9]-[A-Za-z0-9_-]{40,}'
  'ghp_[A-Za-z0-9]{36}'
  'github_pat_[A-Za-z0-9_]{22}_[A-Za-z0-9]{59}'
  'AIza[0-9A-Za-z_-]{35}'
  'AKIA[0-9A-Z]{16}'
  'sk_live_[A-Za-z0-9]{24,}'
  'xoxb-[0-9]+-[0-9]+-[A-Za-z0-9]{24,}'
  'npm_[A-Za-z0-9]{36}'
)

found=0
for pat in "${SUSPECT_PATTERNS[@]}"; do
  # Search only test files
  while IFS= read -r -d '' f; do
    # Grep for pattern; check each match for TESTONLY marker context (within 50 chars)
    matches=$(grep -oE "$pat" "$f" 2>/dev/null || true)
    if [[ -z "$matches" ]]; then continue; fi
    while IFS= read -r m; do
      if [[ -z "$m" ]]; then continue; fi
      # Check if the match (or its surrounding 50 chars of context) contains TESTONLY
      context=$(grep -oE ".{0,50}$(printf '%s' "$m" | sed 's/[][\/.*^$()]/\\&/g').{0,50}" "$f" 2>/dev/null | head -1 || true)
      # Safe markers: TESTONLY (our convention) or EXAMPLE (AWS canonical sample)
      if [[ "$context" != *TESTONLY* && "$context" != *EXAMPLE* && "$m" != *EXAMPLE* ]]; then
        echo "FAIL: $f contains real-looking secret matching /$pat/ without TESTONLY marker"
        echo "  match: $m"
        found=$((found + 1))
      fi
    done <<< "$matches"
  done < <(find "$REPO_ROOT/src" "$REPO_ROOT/tests" -type f \( -name '*.test.ts' -o -name '*.test.js' -o -name '*.spec.ts' \) -print0 2>/dev/null || true)
done

if [[ $found -gt 0 ]]; then
  echo ""
  echo "$found suspect secret(s) found in test files."
  echo "Use the TESTONLY_NOTASECRET_ padding convention."
  exit 1
fi
echo "OK: no real-looking secrets in test files."
