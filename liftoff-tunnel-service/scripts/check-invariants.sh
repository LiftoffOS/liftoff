#!/usr/bin/env bash
#
# check-invariants.sh — runnable fitness functions for docs/invariants.md.
#
# Turns the `Drift check:` lines of the `social` invariants into real checks so a
# human, CI, or a scheduled drift scanner can CALL them instead of paraphrasing.
# This repo has no Go CI yet, so these grep-based checks are the only automated
# guard today; they intentionally do NOT shell out to `go` (so the script runs
# anywhere, including hosts without a Go toolchain). INV-TUN-007 is therefore a
# NOTICE reminding you to run the Go toolchain yourself / in CI.
#
# Two kinds of check:
#   state   — a property of the current tree (e.g. "chisel default bind is loopback").
#             Always evaluated; can FAIL.
#   change  — a "do not ADD X" rule (a chisel fork, a manual deploy, a meter). These
#             are about a diff, so they only FAIL in --changed mode against the files a
#             branch actually touched. In full-tree mode they print any existing
#             baseline as NOTICE and never fail (existing code is not a regression).
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

# --- INV-TUN-001 — Data plane stays on stock chisel (no fork) -----------------------
# state: go.mod has no `replace` redirecting chisel, and every chisel require is the
# upstream jpillora module. The customer image builds FROM jpillora/chisel.
forkreplace=$(grep -nE '^\s*replace\b.*chisel' go.mod 2>/dev/null || true)
forkrequire=$(grep -inE '[^ ]*chisel[^ ]*\s+v' go.mod 2>/dev/null | grep -v 'github.com/jpillora/chisel' || true)
forkbase=$(grep -inE '^\s*FROM\s+.*chisel' client/Dockerfile 2>/dev/null | grep -viE 'jpillora/chisel' || true)
if [ -n "$forkreplace$forkrequire$forkbase" ]; then
  failed "INV-TUN-001 (state): chisel fork detected (replace/non-jpillora require/non-jpillora client base):"
  [ -n "$forkreplace" ] && echo "$forkreplace"
  [ -n "$forkrequire" ] && echo "$forkrequire"
  [ -n "$forkbase" ] && echo "$forkbase"
else
  pass "INV-TUN-001 (state): data plane depends only on stock github.com/jpillora/chisel"
fi
# change: this branch must not introduce a chisel fork / replace directive.
if [ "$MODE" = changed ]; then
  cf=$(changed_files '(^go\.mod$|client/Dockerfile$)'); newfork=""
  [ -n "$cf" ] && newfork=$(echo "$cf" | xargs grep -inE 'replace\b.*chisel|FROM\s+.*chisel' 2>/dev/null | grep -viE 'jpillora/chisel' || true)
  if [ -n "$newfork" ]; then failed "INV-TUN-001 (change): this branch introduces a chisel fork / replace. Data plane must stay stock:"; echo "$newfork"; else pass "INV-TUN-001 (change): no chisel fork introduced in the diff"; fi
fi

# --- INV-TUN-002 — Chisel binds loopback only; :8080 is the sole public port --------
# state: CHISEL_BIND_ADDR default is loopback; Dockerfile does not EXPOSE 7000.
binddefault=$(grep -nE 'CHISEL_BIND_ADDR"?,\s*"127\.0\.0\.1:' internal/config/config.go 2>/dev/null || true)
if [ -n "$binddefault" ]; then pass "INV-TUN-002 (state): CHISEL_BIND_ADDR default is loopback (127.0.0.1)"; else failed "INV-TUN-002 (state): CHISEL_BIND_ADDR default is not 127.0.0.1 in internal/config/config.go"; fi
badexpose=$(grep -nE '^\s*EXPOSE\s+7000' Dockerfile 2>/dev/null || true)
if [ -n "$badexpose" ]; then failed "INV-TUN-002 (state): Dockerfile EXPOSEs the loopback chisel port 7000 — it must stay internal:"; echo "$badexpose"; else pass "INV-TUN-002 (state): Dockerfile does not EXPOSE the loopback chisel port"; fi

# --- INV-TUN-003 — Tenant route isolation ------------------------------------------
# state: the zero-loopback-port guard remains before any localhost dial.
guard=$(grep -nE 'LoopbackPort == 0' internal/dataplane/http_reverse_proxy.go 2>/dev/null || true)
if [ -n "$guard" ]; then pass "INV-TUN-003 (state): zero-LoopbackPort guard present before the loopback dial"; else failed "INV-TUN-003 (state): missing 'LoopbackPort == 0' guard in http_reverse_proxy.go — a stale route could dial localhost:0"; fi

# --- INV-TUN-004 — Prefix-scoped tunnel-token auth ---------------------------------
# state: verifier keeps the tk_ prefix check + ENABLED-only version filter + per-prefix secret name.
tkprefix=$(grep -nE 'HasPrefix\(pass, *"tk_"\)' internal/auth/token_source.go 2>/dev/null || true)
enabledonly=$(grep -nE 'state:ENABLED' internal/auth/token_source.go 2>/dev/null || true)
secretfmt=$(grep -nE 'mcp-tunnel-token-%s' internal/auth/token_source.go 2>/dev/null || true)
if [ -n "$tkprefix" ] && [ -n "$enabledonly" ] && [ -n "$secretfmt" ]; then
  pass "INV-TUN-004 (state): tk_ prefix check + state:ENABLED filter + per-prefix secret name all present"
else
  failed "INV-TUN-004 (state): token auth weakened — missing tk_ check, ENABLED-only filter, or mcp-tunnel-token-{prefix} lookup"
fi

# --- INV-TUN-005 — Wildcard-cert hostname scheme -----------------------------------
# state: TUNNEL_BASE_DOMAIN default stays under the wildcard cert domain.
basedomain=$(grep -nE 'TUNNEL_BASE_DOMAIN"?,\s*"tunnels\.liftoffos\.com"' internal/config/config.go 2>/dev/null || true)
if [ -n "$basedomain" ]; then pass "INV-TUN-005 (state): TUNNEL_BASE_DOMAIN default is tunnels.example.com (matches *.tunnels.example.com cert)"; else failed "INV-TUN-005 (state): TUNNEL_BASE_DOMAIN default no longer tunnels.example.com — verify the wildcard cert still covers it"; fi

# --- INV-TUN-006 — No meter in this service ----------------------------------------
# state: no Stripe meter creation / meter_events / Stripe SDK anywhere in the tree.
meterhit=$(grep -rInE 'meters\.create|meter_events|stripe' --include='*.go' --include='*.ts' --include='*.js' . 2>/dev/null | grep -v '/vendor/' || true)
if [ -n "$meterhit" ]; then failed "INV-TUN-006 (state): meter/Stripe symbol found — this service must only emit into the cost-attribution ingester:"; echo "$meterhit"; else pass "INV-TUN-006 (state): no Stripe/meter creation in the tree"; fi

# --- INV-TUN-007 — Build / test baseline -------------------------------------------
notice "INV-TUN-007: run 'go build ./... && go vet ./... && gofmt -l . && go test ./...' yourself / in CI (this script does not shell out to go)."

# --- INV-TUN-008 — Deploy discipline: no manual build/deploy introduced -------------
if [ "$MODE" = changed ]; then
  cf=$(changed_files '\.(sh|ya?ml)$'); mb=""
  [ -n "$cf" ] && mb=$(echo "$cf" | xargs grep -InE 'gcloud builds submit|gcloud run deploy' 2>/dev/null | grep -vE '^\s*#|Skip when' || true)
  if [ -n "$mb" ]; then failed "INV-TUN-008 (change): this branch adds a manual 'gcloud builds submit' / 'gcloud run deploy'. Deploys are trigger-only; the pipeline's guarded 'services update --image' is the sanctioned path:"; echo "$mb"; else pass "INV-TUN-008 (change): no manual build/deploy introduced"; fi
else
  base=$(grep -rInE 'gcloud builds submit|gcloud run deploy' --include='*.sh' --include='*.yaml' --include='*.yml' . 2>/dev/null | grep -vE '^\s*#|scripts/check-invariants\.sh:' || true)
  [ -n "$base" ] && notice "INV-TUN-008 (baseline): existing manual build/deploy string(s) below. Enforced on diffs via --changed:" && echo "$base"
  [ -z "$base" ] && pass "INV-TUN-008 (state): no manual build/deploy strings in the tree"
fi

echo
echo "== Delegated (enforced elsewhere) =="
echo "  (none yet) — there is no Go CI workflow. Adding go build/vet/test + a go.mod fork gate"
echo "  is the top automation candidate; until then every invariant above is social/partial-gate."
echo
if [ "$fail" -eq 0 ]; then echo "RESULT: clean"; else echo "RESULT: violations found"; fi
exit "$fail"
