#!/usr/bin/env bash
#
# check-invariants.sh — runnable fitness functions for docs/invariants.md (liftoff-react).
#
# Turns the `Drift check:` lines of the `social` invariants into real checks so a
# human, CI, or the scheduled drift scanner can CALL them instead of paraphrasing.
# Invariants already covered by a lint rule or CI gate are listed under "Delegated"
# and are NOT re-implemented here (single source of enforcement).
#
# Two kinds of check:
#   state   — a property of the current tree (e.g. "the only product <Routes> is in
#             src/App.tsx"). Always evaluated; can FAIL.
#   change  — a "do not ADD X" rule (a new backend fetch in a component, a new "agent"
#             in user copy, a new em dash). These are inherently about a diff, so they
#             only FAIL in --changed mode against the files a branch actually touched.
#             In full-tree mode they print the existing baseline as NOTICE and never
#             fail (existing code is not a regression).
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

# Files a branch changed vs origin/main, filtered to a path/extension ERE ($1).
changed_files() { git diff --name-only origin/main...HEAD 2>/dev/null | grep -E "$1" || true; }

echo "== docs/invariants.md fitness functions (mode: $MODE) =="

# --- INV-UI-002 — Routes are defined in App.tsx -----------------------------------
# state: the only product file with a top-level <Routes> is src/App.tsx.
stray=$(grep -rIl "<Routes" src 2>/dev/null | grep -vE '\.test\.|\.stories\.' | grep -v '^src/App.tsx$' || true)
if [ -n "$stray" ]; then failed "INV-UI-002 (state): <Routes> found outside src/App.tsx:"; echo "$stray"; else pass "INV-UI-002 (state): src/App.tsx is the only product route table"; fi

# --- INV-UI-001 — Backend calls go through the services layer ----------------------
# change: no NEW ad-hoc fetch( added in a component or page (services/hooks may wrap fetch).
if [ "$MODE" = changed ]; then
  cf=$(changed_files '^src/(components|pages)/.*\.tsx$' | grep -v '\.test\.' || true); newfetch=""
  [ -n "$cf" ] && newfetch=$(git diff origin/main...HEAD -- $cf 2>/dev/null | grep -E '^\+' | grep -v '^\+\+\+' | grep -E '\bfetch\(' || true)
  if [ -n "$newfetch" ]; then failed "INV-UI-001 (change): ad-hoc fetch( added in a component/page. Route backend calls through src/services/api.ts (apiFetch). Cross-origin non-backend calls are exempt:"; echo "$newfetch"; else pass "INV-UI-001 (change): no new ad-hoc fetch( in components/pages"; fi
else
  base=$(grep -rInE '\bfetch\(' src/components src/pages 2>/dev/null | grep -v '\.test\.' || true)
  [ -n "$base" ] && notice "INV-UI-001 (baseline): existing fetch( callsite(s) in components/pages (some are legit cross-origin; enforced on diffs via --changed):" && echo "$base" | head -20
fi

# --- INV-UI-003 — Never say "AI team" to users -------------------------------------
# change: flag added lines that put the phrase "AI team(s)" inside JSX text / a quoted
# string in changed .tsx files. Comments are excluded as best a heuristic can.
#
# The thing that does the work is called an agent. "Team" alone is ambiguous
# between people and software, and anyone arriving at this repository comes
# from an ecosystem where the word for it is "agent".
#
# Backticks count as a quote style, and ${...} spans are cut out before the
# phrase is looked for. Copy assembled from a template is still copy, and
# stripping the interpolations leaves the words a reader actually sees.
#
# No identifier exclusions are needed. "AI team" is two words with a space, so
# it cannot appear inside an identifier: there is no Agent[A-Z] pass and no
# agentId allow-list because there is nothing for the phrase to collide with.
# Comment lines are dropped outright, so prose about the rule cannot trip it.
if [ "$MODE" = changed ]; then
  cf=$(changed_files '^src/.*\.tsx$' | grep -v '\.test\.' || true); agent=""
  if [ -n "$cf" ]; then
    agent=$(git diff origin/main...HEAD -- $cf 2>/dev/null \
      | grep -E '^\+' | grep -v '^\+\+\+' \
      | grep -vE '^\+[[:space:]]*(//|\*|/\*)' \
      | sed 's/\${[^}]*}//g' \
      | grep -iE '(>[^<]*\bAI teams?\b|"[^"]*\bAI teams?\b|`[^`]*\bAI teams?\b|'"'"'[^'"'"']*\bAI teams?\b)' \
      | grep -viE 'import |from ' || true)
  fi
  if [ -n "$agent" ]; then failed "INV-UI-003 (change): added user-facing copy appears to contain 'AI team'. Use 'agent' / the agent's name:"; echo "$agent"; else pass "INV-UI-003 (change): no new 'AI team' in user copy detected"; fi
else
  notice "INV-UI-003: change gate. Run with --changed in CI to flag 'AI team' newly added to user-facing copy."
fi

# --- INV-UI-004 — No em dashes in user-facing copy ---------------------------------
# change: flag added lines containing an em dash in changed .tsx/.css files.
if [ "$MODE" = changed ]; then
  cf=$(changed_files '^src/.*\.(tsx|css)$' | grep -v '\.test\.' || true); emdash=""
  [ -n "$cf" ] && emdash=$(git diff origin/main...HEAD -- $cf 2>/dev/null | grep -E '^\+' | grep -v '^\+\+\+' | grep -F '—' || true)
  if [ -n "$emdash" ]; then failed "INV-UI-004 (change): em dash added in user-facing copy. Rewrite with a period/comma/parentheses:"; echo "$emdash"; else pass "INV-UI-004 (change): no em dash added to src copy"; fi
else
  n=$(grep -rIl '—' src --include='*.tsx' --include='*.css' 2>/dev/null | wc -l | tr -d ' ')
  [ "$n" -gt 0 ] && notice "INV-UI-004 (baseline): $n src file(s) contain an em dash. Enforced on diffs via --changed; not a regression on its own."
fi

# --- INV-UI-005 — Colors come from design tokens -----------------------------------
# change: notice new hard-coded hex literals added to changed .css files.
if [ "$MODE" = changed ]; then
  cf=$(changed_files '^src/.*\.css$' || true); hex=""
  [ -n "$cf" ] && hex=$(git diff origin/main...HEAD -- $cf 2>/dev/null | grep -E '^\+' | grep -v '^\+\+\+' | grep -iE '#[0-9a-f]{6}\b' || true)
  if [ -n "$hex" ]; then notice "INV-UI-005 (change): hard-coded hex added to a stylesheet. Prefer a --color-* token from src/index.css if one fits:"; echo "$hex"; else pass "INV-UI-005 (change): no new hard-coded hex in changed stylesheets"; fi
else
  notice "INV-UI-005: change gate. Run with --changed in CI to notice hard-coded hex added to stylesheets (large existing baseline)."
fi

# --- INV-UI-008 - No numbered duplicate source files (iCloud/Finder artifacts) ------
# Finder/iCloud sync can materialize "Name 2.tsx" / "Name 3.css" copies that the
# build glob picks up (Codex connector plan E1). Any numbered duplicate under
# src/ is a hard violation.
dupes=$(find src -name '* [0-9].*' -type f 2>/dev/null || true)
if [ -n "$dupes" ]; then
  fail=1
  printf '  FAIL   INV-UI-008: numbered duplicate source files found (delete these iCloud/Finder copies):\n'
  echo "$dupes"
else
  pass "INV-UI-008: no numbered duplicate source files under src/"
fi

echo
echo "== Delegated (enforced elsewhere; not re-checked here) =="
echo "  INV-UI-006 Green gates / deploy -> pre-commit lint-staged + .github/workflows/ci.yml (lint,test,build,bundle-size,docker-scan)"
echo "  INV-UI-007 Conventional PR titles -> .github/workflows/ci.yml (pr-title job)"
echo
if [ "$fail" -eq 0 ]; then echo "RESULT: clean"; else echo "RESULT: violations found"; fi
exit "$fail"
