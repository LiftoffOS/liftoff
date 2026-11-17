#!/usr/bin/env bash
#
# check-invariants.sh — runnable fitness functions for docs/invariants.md.
#
# Turns the `Drift check:` lines of the `social` / style invariants into real checks so a
# human, CI, or the scheduled drift scanner can CALL them instead of paraphrasing. The
# heavy wire-safety invariants (breaking changes, rolling-upgrade compat) are already
# enforced by buf and the CI matrix and are NOT re-implemented here — they are listed under
# "Delegated" (single source of enforcement). This script needs no buf/npm toolchain, so
# the drift scanner can run it anywhere.
#
# Two kinds of check:
#   state   — a property of the current tree (e.g. "every enum zero value is _UNSPECIFIED").
#             Always evaluated; can FAIL.
#   change  — a "you changed X so you must also do Y" rule (bump the version, regenerate
#             stubs). Inherently about a diff, so they only FAIL in --changed mode against
#             the files a branch actually touched. In full-tree mode they print a NOTICE
#             and never fail.
#
# Usage:  scripts/check-invariants.sh            # state checks + baseline notices
#         scripts/check-invariants.sh --changed  # also enforce change-rules on the diff vs origin/main
# Exit code: 0 = clean, 1 = at least one FAIL. NOTICE lines never fail the run.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

MODE=full
[ "${1:-}" = "--changed" ] && MODE=changed

fail=0
pass()   { printf '  PASS   %s\n' "$1"; }
notice() { printf '  NOTICE %s\n' "$1"; }
failed() { printf '  FAIL   %s\n' "$1"; fail=1; }

# Files a branch changed vs origin/main, filtered to an ERE ($1).
changed_files() { git diff --name-only origin/main...HEAD 2>/dev/null | grep -E "$1" || true; }

PROTOS="$(find liftoff -name '*.proto' 2>/dev/null | sort)"

echo "== docs/invariants.md fitness functions (mode: $MODE) =="

# --- INV-PROTO-004a — enum zero value is named <PREFIX>_UNSPECIFIED --------------------
# In proto3 a field number is never 0, so a `= 0;` line is always an enum zero value.
badzero=""
if [ -n "$PROTOS" ]; then
  while IFS= read -r hit; do
    [ -z "$hit" ] && continue
    name=$(printf '%s' "$hit" | sed -E 's/.*[: ]([A-Za-z0-9_]+)[[:space:]]*=[[:space:]]*0[[:space:]]*;.*/\1/')
    case "$name" in
      *_UNSPECIFIED) ;;
      *) badzero="${badzero}${hit}"$'\n' ;;
    esac
  done < <(echo "$PROTOS" | xargs grep -HnE '=[[:space:]]*0[[:space:]]*;' 2>/dev/null || true)
fi
if [ -n "$badzero" ]; then failed "INV-PROTO-004a (state): enum zero value not named *_UNSPECIFIED:"; printf '%s' "$badzero"; else pass "INV-PROTO-004a (state): every enum zero value is *_UNSPECIFIED"; fi

# --- INV-PROTO-004b — package declaration matches directory path ----------------------
badpkg=""
if [ -n "$PROTOS" ]; then
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    pkg=$(grep -E '^package[[:space:]]' "$f" | head -1 | sed -E 's/^package[[:space:]]+([A-Za-z0-9_.]+)[[:space:]]*;.*/\1/')
    [ -z "$pkg" ] && continue
    expected=$(printf '%s' "$pkg" | tr '.' '/')
    dir=$(dirname "$f")
    [ "$dir" = "$expected" ] || badpkg="${badpkg}${f}: package '${pkg}' expects dir '${expected}'"$'\n'
  done < <(echo "$PROTOS")
fi
if [ -n "$badpkg" ]; then failed "INV-PROTO-004b (state): package name does not mirror directory:"; printf '%s' "$badpkg"; else pass "INV-PROTO-004b (state): every package name mirrors its directory"; fi

# NB: the "document every field/enum/RPC" half of INV-PROTO-004 is intentionally NOT a
# fitness function here. buf lint STANDARD does not include the COMMENTS category, the tree
# has many uncommented fields today, and any heuristic scan produces hundreds of low-signal
# notices. Comment coverage stays `social` (promote by enabling buf's COMMENT_* rules).

# --- INV-PROTO-003 — committed gen/ts tracks the .proto source ------------------------
if [ "$MODE" = changed ]; then
  protochg=$(changed_files '^liftoff/.*\.proto$')
  genchg=$(changed_files '^gen/')
  if [ -n "$protochg" ] && [ -z "$genchg" ]; then
    failed "INV-PROTO-003 (change): liftoff/*.proto changed but gen/ was not regenerated. Run 'buf generate' (or npm run regenerate) and commit gen/:"; echo "$protochg"
  else
    pass "INV-PROTO-003 (change): proto and gen/ changes are consistent"
  fi
else
  notice "INV-PROTO-003: gen/ drift is enforced by ci.yml + publish.yml ('git diff --quiet gen/'). Run with --changed to flag locally."
fi

# --- INV-PROTO-005 — published-surface change must bump package.json version ----------
if [ "$MODE" = changed ]; then
  surface=$(changed_files '^(liftoff/|gen/|event-schemas/)')
  verchg=$(changed_files '^package\.json$')
  bumped=""
  if [ -n "$verchg" ]; then bumped=$(git diff origin/main...HEAD -- package.json 2>/dev/null | grep -E '^\+[[:space:]]*"version":' || true); fi
  if [ -n "$surface" ] && [ -z "$bumped" ]; then
    failed "INV-PROTO-005 (change): published surface changed but package.json version was not bumped:"; echo "$surface"
  else
    pass "INV-PROTO-005 (change): version bump matches published-surface changes"
  fi
else
  notice "INV-PROTO-005: publish.yml only publishes when package.json version advances. Run with --changed to enforce the bump on a diff."
fi

# --- INV-PROTO-002 — removed field must leave a `reserved` ----------------------------
if [ "$MODE" = changed ]; then
  cf=$(changed_files '^liftoff/.*\.proto$')
  if [ -n "$cf" ]; then
    diffbody=$(git diff origin/main...HEAD -- $cf 2>/dev/null || true)
    removed=$(printf '%s' "$diffbody" | grep -E '^-[[:space:]]*[A-Za-z0-9_.<> ]+[[:space:]]+[a-z_]+[[:space:]]*=[[:space:]]*[0-9]+[[:space:]]*;' | grep -vE '=[[:space:]]*0[[:space:]]*;' || true)
    addedreserved=$(printf '%s' "$diffbody" | grep -E '^\+[[:space:]]*reserved' || true)
    if [ -n "$removed" ] && [ -z "$addedreserved" ]; then
      notice "INV-PROTO-002 (change): a field appears removed but no 'reserved' was added. Reserve the number+name (buf breaking is the hard gate):"; printf '%s\n' "$removed"
    else
      pass "INV-PROTO-002 (change): no unreserved field removal detected"
    fi
  else
    pass "INV-PROTO-002 (change): no proto files changed"
  fi
else
  notice "INV-PROTO-002: reserve removed field numbers/names. buf breaking blocks type-incompatible reuse; run with --changed for the reserved-on-removal heuristic."
fi

# --- INV-PROTO-007 — a new vN (N>=2) package directory is human-gated -----------------
if [ "$MODE" = changed ]; then
  newv=$(changed_files '^liftoff/[a-z_]+/v[2-9][0-9]*/' | sed -E 's#(^liftoff/[a-z_]+/v[0-9]+/).*#\1#' | sort -u || true)
  if [ -n "$newv" ]; then notice "INV-PROTO-007 (change): new versioned package directory touched — v1->vN requires human sign-off:"; echo "$newv"; else pass "INV-PROTO-007 (change): no new vN (N>=2) package directory"; fi
else
  notice "INV-PROTO-007: new vN package dirs require human sign-off; direct pushes to main are blocked by branch protection."
fi

echo
echo "== Delegated (enforced elsewhere; not re-checked here) =="
echo "  INV-PROTO-001 breaking wire changes -> buf breaking in .github/workflows/ci.yml + rolling-compat.yml"
echo "  INV-PROTO-006 both-sides-green      -> .github/workflows/rolling-compat.yml + consumer-fanout.yml"
echo
if [ "$fail" -eq 0 ]; then echo "RESULT: clean"; else echo "RESULT: violations found"; fi
exit "$fail"
