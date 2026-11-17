#!/usr/bin/env bash
# check-proto-contracts.sh
#
# Validates that proto contracts in liftoff-platform-backend have not
# introduced breaking changes relative to the main branch.
#
# Run from the liftoff-platform-backend directory.
# Install buf: https://buf.build/docs/installation
#
# ─────────────────────────────────────────────────────────────────────────────
# buf.yaml TEMPLATE
# liftoff-platform-backend would need a buf.yaml at src/proto/ with
# content similar to the following to enable buf lint and breaking checks:
#
#   version: v2
#   modules:
#     - path: .
#       name: buf.build/liftoffos/platform-backend
#   lint:
#     use:
#       - DEFAULT
#   breaking:
#     use:
#       - FILE
#     ignore_unstable_packages: true
#
# See https://buf.build/docs/configuration/v2/buf-yaml for full reference.
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail
cd "$(dirname "$0")/../../"

if ! command -v buf &>/dev/null; then
  echo "buf not installed. Install from https://buf.build/docs/installation"
  echo "For now, manually check src/proto/ for breaking changes."
  exit 1
fi

buf breaking src/proto --against '.git#branch=main,subdir=src/proto'
echo "No breaking proto changes detected."
