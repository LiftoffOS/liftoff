#!/usr/bin/env bash
#
# CI fence: the canonical voice block is identical in platform-backend and
# tenant-runtime.
#
# packages/shared-types/src/agent-voice.ts holds the voice and confidentiality rules
# every customer-facing surface carries. Both repos vendor that package, and neither
# repo's test suite can see the other's copy, so nothing inside a single checkout can
# notice the two drifting apart.
#
# That is not a hypothetical. The arrangement this replaced had the same rules in two
# places (platform-backend's distill preamble and tenant-runtime's chat prompt) with a
# comment in one claiming it mirrored the other, and they had already diverged on three
# rules: the contraction rule and the "never say agent" rule were missing from one, the
# bullets rule from the other. The shared-types trees themselves are NOT byte-identical
# either (tenant-runtime's copy lags platform-backend's by several files), so vendoring
# alone guarantees nothing. This is the check that does.
#
# Usage:
#   scripts/ci-fences/agent-voice-parity.sh [sibling-repo-path]
#
# The sibling is found from, in order: $1, $AGENT_VOICE_SIBLING_REPO, then the
# conventional sibling checkout next to this one.
#
# Exit codes:
#   0 = the two copies match
#   1 = they differ (or the local copy is missing/malformed)
#   2 = INCONCLUSIVE: the sibling checkout is not available here
#
# Exit 2 does NOT block, following the same convention as
# scripts/ci/verify-migrations.sh: a check that could not run knows nothing about the
# thing it was meant to check, and reporting that honestly is better than a green tick
# that means "absent". A single-repo CI runner will normally exit 2; the check earns
# its keep in a developer checkout and in any pipeline that has both trees.

set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SELF_DIR/../.." && pwd)"
REL_PATH="packages/shared-types/src/agent-voice.ts"
LOCAL_FILE="$REPO_ROOT/$REL_PATH"

if [[ ! -f "$LOCAL_FILE" ]]; then
  echo "agent-voice-parity: FAIL — $REL_PATH is missing from this repo." >&2
  exit 1
fi

# Resolve the sibling checkout.
#
# WHY THE MAIN CHECKOUT RATHER THAN $REPO_ROOT. This used to switch on
# `basename "$REPO_ROOT"`, which is the repository's directory name only when the
# caller is the main checkout. In a git worktree the basename is whatever the
# worktree was called — `oss-no-domain`, a branch name, a ticket id — so
# neither arm matched, SIBLING stayed empty, and the check exited 2 (INCONCLUSIVE,
# non-blocking).
#
# That is not a cosmetic gap. Agents and developers do this work in worktrees, so
# in practice the fence was silent exactly where the editing happens, and it stayed
# silent long enough for the two repos to drift a whole vocabulary rule apart: the
# runtime sat on a one-sentence version of the rule while platform-backend carried
# the full one, and every run of this script reported INCONCLUSIVE rather than FAIL.
#
# `git rev-parse --path-format=absolute --git-common-dir` gives the SHARED .git
# directory for both a main checkout and any worktree of it, so its parent is the
# main checkout whatever we were invoked from.
if [[ -z "${1:-}" && -z "${AGENT_VOICE_SIBLING_REPO:-}" ]]; then
  MAIN_CHECKOUT="$(git -C "$REPO_ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  if [[ -n "$MAIN_CHECKOUT" ]]; then
    MAIN_CHECKOUT="$(dirname "$MAIN_CHECKOUT")"
  else
    MAIN_CHECKOUT="$REPO_ROOT"
  fi
fi

SIBLING="${1:-${AGENT_VOICE_SIBLING_REPO:-}}"
if [[ -z "$SIBLING" ]]; then
  case "$(basename "$MAIN_CHECKOUT")" in
    *Platform-Backend*|*platform-backend*) SIBLING="$(dirname "$MAIN_CHECKOUT")/Liftoff-Tenant-Runtime" ;;
    *Tenant-Runtime*|*tenant-runtime*)     SIBLING="$(dirname "$MAIN_CHECKOUT")/liftoff-platform-backend" ;;
  esac
fi

if [[ -z "$SIBLING" || ! -f "$SIBLING/$REL_PATH" ]]; then
  echo "agent-voice-parity: INCONCLUSIVE — no sibling checkout carrying $REL_PATH."
  echo "  Looked for: ${SIBLING:-<undetermined>}"
  echo "  Pass the path as an argument or set AGENT_VOICE_SIBLING_REPO to check parity."
  exit 2
fi

# Compare the block text and the pinned checksum, not the whole file: the surrounding
# comments legitimately describe each repo from its own side.
extract_block() {
  # Everything between the opening backtick of AGENT_VOICE_BLOCK and its closing one.
  sed -n '/^export const AGENT_VOICE_BLOCK = `/,/^`;$/p' "$1"
}
extract_sha() {
  sed -n "s/^export const AGENT_VOICE_BLOCK_SHA = '\(.*\)';$/\1/p" "$1"
}

local_block="$(extract_block "$LOCAL_FILE")"
sibling_block="$(extract_block "$SIBLING/$REL_PATH")"
local_sha="$(extract_sha "$LOCAL_FILE")"
sibling_sha="$(extract_sha "$SIBLING/$REL_PATH")"

if [[ -z "$local_block" || -z "$local_sha" ]]; then
  echo "agent-voice-parity: FAIL — could not parse AGENT_VOICE_BLOCK/_SHA out of $REL_PATH." >&2
  echo "  The declaration shape this fence greps for has changed; update the fence." >&2
  exit 1
fi

status=0

if [[ "$local_block" != "$sibling_block" ]]; then
  echo "FAIL  the voice block text differs between the two repos." >&2
  echo "      this repo: $LOCAL_FILE" >&2
  echo "      sibling:   $SIBLING/$REL_PATH" >&2
  echo "" >&2
  diff <(printf '%s\n' "$local_block") <(printf '%s\n' "$sibling_block") >&2 || true
  echo "" >&2
  status=1
fi

if [[ "$local_sha" != "$sibling_sha" ]]; then
  echo "FAIL  AGENT_VOICE_BLOCK_SHA differs: '$local_sha' here, '$sibling_sha' in the sibling." >&2
  status=1
fi

if [[ $status -ne 0 ]]; then
  echo "agent-voice-parity: the two repos disagree about what every customer-facing" >&2
  echo "  surface is told. Make the identical edit in both, and remember the Chief AI" >&2
  echo "  Officer's copy lives in the database and needs a new migration." >&2
  exit 1
fi

echo "agent-voice-parity: clean — both repos carry the same block (sha $local_sha)."
