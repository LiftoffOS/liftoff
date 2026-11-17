#!/usr/bin/env bash
#
# check-invariants.sh — runnable fitness functions for docs/invariants.md.
#
# Turns the `Drift check:` lines of the invariants into real checks so a
# human, CI, or the scheduled drift scanner can CALL them instead of
# paraphrasing. Invariants already fully covered by a verification test are
# listed under "Delegated" and are NOT re-implemented here (single source of
# enforcement).
#
# Two kinds of check:
#   state   — a property of the current tree (e.g. "src/routes/ holds only
#             health.ts"). Always evaluated; can FAIL.
#   change  — a "do not ADD X" rule (new meter, manual build). These are
#             inherently about a diff, so they only FAIL in --changed mode
#             against the files a branch actually touched. In full-tree mode
#             they print the existing baseline as NOTICE and never fail.
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

# Files a branch changed vs origin/main, filtered to an extension ERE ($1).
changed_files() { git diff --name-only origin/main...HEAD 2>/dev/null | grep -E "$1" || true; }

echo "== docs/invariants.md fitness functions (mode: $MODE) =="

# --- INV-HARV-001 — Harvest is invisible to end users -----------------------------
# state: src/routes/ exposes only the health/ready surface — no tenant-facing route.
extra_routes=$(find src/routes -type f -name '*.ts' ! -name 'health.ts' 2>/dev/null || true)
if [ -n "$extra_routes" ]; then failed "INV-HARV-001 (state): route file(s) other than health.ts under src/routes — a new HTTP surface risks disclosing harvest:"; echo "$extra_routes"; else pass "INV-HARV-001 (state): src/routes exposes only health.ts (/health, /ready)"; fi
# state: no Express response body mentions "harvest" (never disclose in an HTTP response).
# Match a send that carries a body argument (`.json({...})`, `.send(...)`) so we do NOT
# flag `await res.json()` fetch-response *reads*, which take no argument.
disclose=$(grep -rInE "\.(json|send|end)\([^)]" src 2>/dev/null | grep -i "harvest" || true)
if [ -n "$disclose" ]; then failed "INV-HARV-001 (state): an Express response body mentions 'harvest' — do not disclose the pipeline to callers:"; echo "$disclose"; else pass "INV-HARV-001 (state): no Express response body mentions harvest"; fi

# --- INV-HARV-002 — Per-tenant opt-in, fail-closed --------------------------------
# state: the opt-in gate is present in the pipeline and fails closed.
if grep -q "isTenantHarvestEnabled" src/runner.ts 2>/dev/null; then
  # count fail-closed returns inside the gate (non-200 branch + catch branch).
  falseclose=$(awk '/async function isTenantHarvestEnabled/{f=1} f&&/return false/{c++} f&&/^}/{if(seen)f=0; seen=1} END{print c+0}' src/runner.ts)
  if [ "${falseclose:-0}" -ge 2 ]; then pass "INV-HARV-002 (state): isTenantHarvestEnabled present and fails closed (>=2 return false)"; else failed "INV-HARV-002 (state): isTenantHarvestEnabled does not clearly fail closed (expected return false on non-200 and catch)"; fi
else
  failed "INV-HARV-002 (state): isTenantHarvestEnabled gate missing from src/runner.ts — harvest would run for un-opted-in tenants"
fi

# --- INV-HARV-003 — Cross-tenant isolation of memory writes -----------------------
# state: prod must never fall back to a shared runtime URL (guarded throw present).
if grep -q "Cannot resolve tenant runtime URL" src/memory-client.ts 2>/dev/null; then pass "INV-HARV-003 (state): resolveRuntimeUrl throws in prod rather than using a shared TENANT_RUNTIME_URL"; else failed "INV-HARV-003 (state): prod runtime-URL guard missing from src/memory-client.ts — risk of cross-tenant memory write"; fi
# state: connector->tenant ownership is validated and fails closed.
if grep -q "validateConnectorOwnership" src/runner.ts 2>/dev/null && grep -q "failing closed" src/runner.ts 2>/dev/null; then pass "INV-HARV-003 (state): validateConnectorOwnership present and fails closed (SEC-001)"; else failed "INV-HARV-003 (state): connector ownership validation (SEC-001) missing or not fail-closed in src/runner.ts"; fi

# --- INV-HARV-004 — Redact PII before the LLM -------------------------------------
# state: redactPii() must precede the llmComplete() call in the classifier.
rp=$(grep -nE "redactPii\(" src/classifier.ts 2>/dev/null | head -1 | cut -d: -f1)
lc=$(grep -nE "llmComplete\(" src/classifier.ts 2>/dev/null | head -1 | cut -d: -f1)
if [ -n "$rp" ] && [ -n "$lc" ] && [ "$rp" -lt "$lc" ]; then pass "INV-HARV-004 (state): redactPii() runs before llmComplete() in classifier.ts (line $rp < $lc)"; else failed "INV-HARV-004 (state): redactPii() does not clearly precede llmComplete() in src/classifier.ts (redact=$rp llm=$lc)"; fi

# --- INV-HARV-005 — LLM only via the platform-backend gateway; one OU meter -------
# state: no direct LLM vendor SDK import/endpoint anywhere in src.
vendor=$(grep -rInE "@anthropic-ai|from ['\"]openai|new Anthropic\(|new OpenAI\(|@google/genai|api\.anthropic\.com|api\.openai\.com" src 2>/dev/null || true)
if [ -n "$vendor" ]; then failed "INV-HARV-005 (state): direct LLM vendor SDK/endpoint in src — all inference must go through platform-backend /api/internal/llm/complete:"; echo "$vendor"; else pass "INV-HARV-005 (state): no direct LLM vendor SDK; inference goes through the gateway"; fi
# state: no per-vendor Stripe meter creation exists in this service.
metercall=$(grep -rInE "meters?\.create\(" src 2>/dev/null || true)
if [ -n "$metercall" ]; then failed "INV-HARV-005 (state): a Stripe meter creation exists in harvest — the only meter is operating_unit_consumed (platform-backend owns it):"; echo "$metercall"; else pass "INV-HARV-005 (state): no Stripe meter creation in harvest"; fi
# change: no new meter creation introduced by this branch.
if [ "$MODE" = changed ]; then
  cf=$(changed_files '\.ts$'); newmeter=""
  [ -n "$cf" ] && newmeter=$(echo "$cf" | xargs grep -InE 'meters?\.create\(' 2>/dev/null || true)
  if [ -n "$newmeter" ]; then failed "INV-HARV-005 (change): this branch adds a Stripe meter creation:"; echo "$newmeter"; else pass "INV-HARV-005 (change): no new meter creation in the diff"; fi
fi

# --- INV-HARV-006 — Idempotent, fail-safe Pub/Sub consumption ---------------------
# state: upfront-claim idempotency and terminal-4xx ack-skip are wired in the runner.
if grep -q "claimMessage" src/runner.ts 2>/dev/null && grep -q "isTerminalGatewayError" src/runner.ts 2>/dev/null; then pass "INV-HARV-006 (state): upfront claimMessage + isTerminalGatewayError ack-skip present in runner.ts"; else failed "INV-HARV-006 (state): idempotency (claimMessage) or terminal-4xx ack-skip missing from src/runner.ts"; fi

# --- INV-HARV-007 — Deploy discipline: no manual build introduced -----------------
if [ "$MODE" = changed ]; then
  cf=$(changed_files '\.(sh|ya?ml)$'); mb=""
  [ -n "$cf" ] && mb=$(echo "$cf" | xargs grep -InE 'gcloud builds submit' 2>/dev/null | grep -vE '# ' || true)
  if [ -n "$mb" ]; then failed "INV-HARV-007 (change): this branch adds a 'gcloud builds submit' action. Deploys are trigger-only:"; echo "$mb"; else pass "INV-HARV-007 (change): no manual build introduced"; fi
else
  notice "INV-HARV-007: change gate. Run with --changed in CI to flag a diff that adds 'gcloud builds submit'."
fi

echo
echo "== Delegated (enforced by tests; not re-checked here) =="
echo "  INV-HARV-002 opt-in fail-closed -> src/__tests__/runner.test.ts (TENANT-OPT-001)"
echo "  INV-HARV-003 cross-tenant iso   -> src/__tests__/runner.test.ts (SEC-001) + runner-chunking.test.ts"
echo "  INV-HARV-004 PII redaction      -> src/__tests__/redact.test.ts"
echo "  INV-HARV-006 terminal-4xx skip  -> src/__tests__/runner.test.ts (terminal 4xx acks and skips)"
echo
if [ "$fail" -eq 0 ]; then echo "RESULT: clean"; else echo "RESULT: violations found"; fi
exit "$fail"
