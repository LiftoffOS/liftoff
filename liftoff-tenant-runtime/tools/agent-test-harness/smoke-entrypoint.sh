#!/usr/bin/env bash
# C.1 — Smoke image unified entrypoint.
#
# The Dockerfile.smoke image is built from the TR repo but is referenced
# by BOTH the TR cloudbuild (post-deploy-smoke step) and the PB
# cloudbuild. The two repos drive different endpoints:
#
#   TR (--mode=tr):  /api/internal/test-harness/run-agent
#                    (driven by tr-runner.ts inside the image)
#   PB (--mode=pb):  /api/internal/test-harness/run-chat
#                    (driven by pb-runner.ts inside the image)
#
# This wrapper picks the right CLI based on --mode=<tr|pb>. All other
# flags pass through unchanged so the per-cloudbuild substitutions
# (_CANARY_TENANT_ID, _CANARY_AGENT_ID, etc.) work identically for both.
#
# Default mode is tr (matches the historical Dockerfile entrypoint).

set -euo pipefail

# Cloud Build runs steps with cwd=/workspace, overriding the image WORKDIR, so
# `node -r ts-node/register` can't resolve the image's /smoke/node_modules. Run from
# /smoke (where package.json + node_modules live) so ts-node and all deps resolve.
cd /smoke

MODE="tr"
PASSTHROUGH=()
for arg in "$@"; do
  case "$arg" in
    --mode=tr) MODE="tr" ;;
    --mode=pb) MODE="pb" ;;
    *) PASSTHROUGH+=("$arg") ;;
  esac
done

case "$MODE" in
  tr)
    exec node --enable-source-maps -r ts-node/register \
      /smoke/tools/agent-test-harness/tr-runner.ts "${PASSTHROUGH[@]}"
    ;;
  pb)
    exec node --enable-source-maps -r ts-node/register \
      /smoke/tools/agent-test-harness/pb-runner.ts "${PASSTHROUGH[@]}"
    ;;
  *)
    echo "smoke-entrypoint: unknown --mode=$MODE (expected tr|pb)" >&2
    exit 2
    ;;
esac
