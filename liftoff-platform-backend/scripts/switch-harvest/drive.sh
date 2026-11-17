#!/usr/bin/env bash
# Drive a real source installation until it holds importable state, then
# snapshot it clean and dirty.
#
# Every invocation here was verified interactively against the real product
# before being written down. That order matters: the README calls the
# interactive session the primary research act, and writing these commands from
# upstream docs would reproduce the authored-fixture trap one level up.
#
# Stage 2 (configuration) needs no model key and produces most of the importable
# surface. Stage 3 (execution) runs only when HARVEST_MODEL_KEY is set, and is
# what creates session databases with their real schemas and the WAL files that
# make the read-only SQLite handling meaningful.

set -euo pipefail

SOURCE="${HARVEST_SOURCE:-openclaw}"
CLEAN=/harvest/snapshot-clean
DIRTY=/harvest/snapshot-dirty

mkdir -p "$CLEAN" "$DIRTY"

# ── openclaw ───────────────────────────────────────────────────────────
drive_openclaw() {
  # Two isolated agents. `agents add` REQUIRES a positional id in
  # non-interactive mode; passing only --workspace fails with "Agent name is
  # required in non-interactive mode."
  openclaw agents add support-triage --workspace /root/ws-support --non-interactive --json >/dev/null
  openclaw agents add weekly-reporting --workspace /root/ws-weekly --non-interactive --json >/dev/null

  # Instruction, skill and memory files live under the agent dir the product
  # reports in `agents list` — ~/.openclaw/agents/<id>/agent.
  local support=/root/.openclaw/agents/support-triage/agent
  local weekly=/root/.openclaw/agents/weekly-reporting/agent
  mkdir -p "$support/skills" "$support/memory" "$weekly/skills"

  cat > "$support/AGENTS.md" <<'MD'
# Support Triage

You own first response on every inbound ticket. Escalate billing questions to
the finance channel.
MD
  cat > "$support/SOUL.md" <<'MD'
Plain language. Acknowledge, then answer. No filler.
MD
  cat > "$support/MEMORY.md" <<'MD'
- The Acme account is on a legacy plan and their invoices are handled manually.
MD
  cat > "$support/memory/2026-08-11.md" <<'MD'
- Customers reporting slow exports are usually hitting the 10k row limit.
MD
  cat > "$support/skills/escalation.md" <<'MD'
# Escalation

P1 within 15 minutes. P2 within a working day.
MD
  cat > "$weekly/AGENTS.md" <<'MD'
# Weekly Reporting

You compile the Monday brief. Numbers first, commentary second.
MD

  # Cron jobs go through the Gateway, which refuses without credentials:
  #   GatewayCredentialsRequiredError: gateway cron.add requires credentials
  # So the gateway is given a local token first. The jobs land in the
  # `cron_jobs` TABLE of ~/.openclaw/state/openclaw.sqlite, not in any JSON
  # file — which is why an adapter reading `cron/jobs.json` finds nothing on a
  # real installation.
  local token='harvest-local-token'
  openclaw config set gateway.auth.token "$token" >/dev/null 2>&1 || true
  openclaw cron add --name triage-hourly --cron '0 * * * *' --agent support-triage \
    --message 'Triage every new ticket and escalate anything flagged urgent.' \
    --token "$token" --json >/dev/null 2>&1 || \
    echo "!! cron add failed; snapshot will have no schedules" >&2
  openclaw cron add --name weekly-brief --cron '0 8 * * 1' --agent weekly-reporting \
    --message 'Compile the Monday brief from last week.' \
    --token "$token" --json >/dev/null 2>&1 || true
}

# ── hermes ─────────────────────────────────────────────────────────────
drive_hermes() {
  # Verified against hermes-agent 0.20.4. State lives under ~/.hermes, and the
  # layout matches what the adapter expected far better than OpenClaw's did:
  # config.yaml, SOUL.md, memories/, skills/ are all real.
  local root=/root/.hermes
  mkdir -p "$root/memories" "$root/skills"

  cat > "$root/SOUL.md" <<'MD'
# Ada

You are careful and concise. Numbers before narrative.
MD
  cat > "$root/memories/MEMORY.md" <<'MD'
- The revenue review is Thursdays at 14:00.
MD
  cat > "$root/skills/reporting.md" <<'MD'
# Reporting

Always include the period and the comparison basis.
MD

  # Cron jobs land in ~/.hermes/cron/jobs.json — a real file here, unlike
  # OpenClaw. `create` needs no gateway; it warns that the gateway is not
  # installed and writes the job anyway.
  #
  # The job's `schedule` is an OBJECT, `{ kind, expr, display }`. Reading it as
  # a string reported every job on a real installation as unconvertible, so a
  # real Hermes import carried no schedules at all.
  hermes cron create '0 * * * *' 'Check revenue for anomalies' --name hourly-watch >/dev/null 2>&1 || true
  hermes cron create '0 8 * * *' 'Send the digest' --name daily-digest >/dev/null 2>&1 || true
}

case "$SOURCE" in
  openclaw) drive_openclaw ;;
  hermes)   drive_hermes ;;
  *) echo "unknown source: $SOURCE" >&2; exit 2 ;;
esac

# Each product keeps its state under its own root; snapshotting a hard-coded
# one silently produced an empty fixture for the other source.
case "$SOURCE" in
  openclaw) STATE_DIR=/root/.openclaw ;;
  hermes)   STATE_DIR=/root/.hermes ;;
esac

# ── snapshot: clean ────────────────────────────────────────────────────
# Taken with nothing running, so SQLite is checkpointed and readable.
cp -a "$STATE_DIR" "$CLEAN/" 2>/dev/null || true
for ws in /root/ws-*; do [ -d "$ws" ] && cp -a "$ws" "$CLEAN/" ; done

# ── snapshot: dirty ────────────────────────────────────────────────────
# The gateway is started and killed mid-write so WAL and uncheckpointed state
# are genuinely present rather than simulated. This is the state the importer
# meets on a machine where the product is still running.
#
# `pkill` is absent from the slim base image, so the pid is captured directly
# rather than matched by name — the pattern form failed silently and produced a
# "dirty" snapshot identical to the clean one.
if [ "$SOURCE" = openclaw ]; then
  openclaw gateway --allow-unconfigured --bind loopback --force >/tmp/gw.log 2>&1 &
  GW_PID=$!
  sleep 8
  kill -9 "$GW_PID" 2>/dev/null || true
fi
cp -a "$STATE_DIR" "$DIRTY/" 2>/dev/null || true
for ws in /root/ws-*; do [ -d "$ws" ] && cp -a "$ws" "$DIRTY/" ; done

echo "drive.sh complete for ${SOURCE}"
