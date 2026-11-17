#!/bin/bash
set -euo pipefail

# === Required env (Cloud Run injects these via cloud-run-sandbox-provider.ts) ===
: "${SANDBOX_JWT_SECRET:?SANDBOX_JWT_SECRET must be set}"
: "${SANDBOX_ID:?SANDBOX_ID must be set}"
: "${TENANT_ID:?TENANT_ID must be set}"
: "${AGENT_ID:?AGENT_ID must be set}"
: "${INSTRUCTION_VERSION:?INSTRUCTION_VERSION must be set}"
: "${RUNTIME_BASE_URL:?RUNTIME_BASE_URL must be set}"

# === Workspace prep ===
mkdir -p "$WORKSPACE_DIR" \
  /workspace/.browser-state \
  /workspace/.browser-logs \
  /workspace/.browser-recordings \
  /workspace/.proxy \
  /workspace/.venv

# Xvfb needs /tmp/.X11-unix to exist with mode 1777. The Docker image's /tmp is
# usually fine, but the X11 socket dir is rarely pre-created — create explicitly.
mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix || true

# nginx writes temp files for body/proxy buffering — make sure target dirs exist
# and are writable. Mirrors paths in nginx.conf's *_temp_path directives.
mkdir -p /tmp/nginx-client-body /tmp/nginx-proxy /tmp/nginx-fastcgi /tmp/nginx-uwsgi /tmp/nginx-scgi

# Marker file so the sidecar TS server can wait on Xvfb before launching Chromium.
touch /tmp/xvfb-pending

# (2) Validate JWT secret is the expected 32-byte hex (sandbox-side defense in depth).
if ! [[ "$SANDBOX_JWT_SECRET" =~ ^[0-9a-f]{64}$ ]]; then
  echo "FATAL: SANDBOX_JWT_SECRET must be 64 hex chars (got len=${#SANDBOX_JWT_SECRET})" >&2
  exit 1
fi

# (3) Probe runtime reachability with a 5s timeout. Soft-fail.
if ! curl -fsS --max-time 5 "${RUNTIME_BASE_URL}/internal/sandbox/health" > /dev/null; then
  echo "WARN: runtime ${RUNTIME_BASE_URL} unreachable at boot — MCP-from-sandbox will degrade until runtime is reachable" >&2
fi

# === Signal handling ===
# tini is PID 1 (set in Dockerfile ENTRYPOINT). supervisord is our long-running child.
# tini propagates SIGTERM to supervisord, which propagates SIGTERM to all programs.

# === Hand off ===
exec /usr/bin/supervisord -c /etc/supervisor/supervisord.conf
