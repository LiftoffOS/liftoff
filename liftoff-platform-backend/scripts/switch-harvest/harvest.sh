#!/usr/bin/env bash
# Harvest adapter fixtures from a REAL source installation.
#
#   ./harvest.sh openclaw [revision]
#   ./harvest.sh hermes   [revision]
#
# Creates the installation from scratch in a disposable container at a pinned
# revision, drives the product's own CLI to produce importable state, snapshots
# it clean and dirty, scrubs secrets, and writes a fixture generation.
#
# Teardown is by DELETION of the container. The product's own uninstaller is
# never trusted for cleanliness.
#
# See README.md for why authored fixtures are not a substitute.

set -euo pipefail

SOURCE="${1:-}"
REVISION="${2:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURES_DIR="${SCRIPT_DIR}/fixtures"

# Pinned revisions verified 2026-08-18. Bumping one adds a NEW generation.
OPENCLAW_PINNED="8032e6c"
HERMES_PINNED="036cbdf"

usage() {
  echo "usage: $0 <openclaw|hermes> [revision]" >&2
  exit 2
}

[[ -n "$SOURCE" ]] || usage

case "$SOURCE" in
  openclaw) REVISION="${REVISION:-$OPENCLAW_PINNED}" ;;
  hermes)   REVISION="${REVISION:-$HERMES_PINNED}" ;;
  *) usage ;;
esac

command -v docker >/dev/null 2>&1 || {
  echo "docker is required: harvest runs in a disposable container so teardown is deletion" >&2
  exit 1
}

OUT_DIR="${FIXTURES_DIR}/${SOURCE}/${REVISION}"
CONTAINER="switch-harvest-${SOURCE}-${REVISION}"

echo "==> Harvesting ${SOURCE} @ ${REVISION}"
echo "    output: ${OUT_DIR}"

if [[ -d "$OUT_DIR" ]]; then
  echo "!! A fixture generation already exists at ${OUT_DIR}." >&2
  echo "   Fixture generations are append-only: updating an adapter for an upstream" >&2
  echo "   schema change must ADD a generation, never rewrite an old one." >&2
  exit 1
fi

cleanup() {
  # Teardown by deletion. Nothing about the container's own uninstall path is
  # trusted, and nothing survives the run.
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

mkdir -p "$OUT_DIR"

# ── 1. build ───────────────────────────────────────────────────────────
docker build \
  --build-arg "SOURCE=${SOURCE}" \
  --build-arg "REVISION=${REVISION}" \
  -f "${SCRIPT_DIR}/Dockerfile.${SOURCE}" \
  -t "${CONTAINER}:latest" \
  "${SCRIPT_DIR}"

# ── 2-3. drive the product ─────────────────────────────────────────────
#
# HARVEST_MODEL_KEY is optional. Without it, stage 2 still produces most of the
# importable surface (agents/profiles, skills, memories, cron jobs, MCP
# definitions, channel config) because those come from configuration commands
# that need no model. With it, stage 3 runs a short burst of real agent turns so
# execution-born state exists — session databases with their real schemas, and
# the WAL files that make the read-only SQLite handling meaningful.
#
# The key never leaves the container and is never committed.
docker run --name "$CONTAINER" \
  -e "HARVEST_MODEL_KEY=${HARVEST_MODEL_KEY:-}" \
  "${CONTAINER}:latest" \
  /harvest/drive.sh

# ── 4. snapshot ────────────────────────────────────────────────────────
echo "==> Snapshotting state"
docker cp "${CONTAINER}:/harvest/snapshot-clean" "${OUT_DIR}/clean"
# The dirty snapshot is taken with the gateway killed mid-write, so WAL and
# uncheckpointed state are genuinely present rather than simulated.
docker cp "${CONTAINER}:/harvest/snapshot-dirty" "${OUT_DIR}/dirty" 2>/dev/null || {
  echo "!! No dirty snapshot produced. The read-only SQLite and WAL tests need one." >&2
  exit 1
}

# ── 5. scrub ───────────────────────────────────────────────────────────
echo "==> Scrubbing secrets into format-realistic fakes"
node "${SCRIPT_DIR}/scrub.js" "${OUT_DIR}"

# ── 6. record provenance ───────────────────────────────────────────────
cat > "${OUT_DIR}/PROVENANCE.json" <<JSON
{
  "source": "${SOURCE}",
  "revision": "${REVISION}",
  "harvestedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "harvestedBy": "scripts/switch-harvest/harvest.sh",
  "executionStateIncluded": $([[ -n "${HARVEST_MODEL_KEY:-}" ]] && echo true || echo false),
  "note": "Generated from a real installation created from scratch in a container. Secrets replaced with format-realistic fakes."
}
JSON

echo "==> Done: ${OUT_DIR}"
echo "    Commit this generation. Do not edit an existing one."
