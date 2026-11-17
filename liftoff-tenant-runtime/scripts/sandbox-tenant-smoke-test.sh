#!/usr/bin/env bash
# scripts/sandbox-tenant-smoke-test.sh — per-tenant acceptance test for aio-sandbox rollout.
# Usage: ./scripts/sandbox-tenant-smoke-test.sh <TENANT_ID>
set -euo pipefail

TENANT_ID="${1:?usage: $0 <TENANT_ID>}"
SHORT_ID="${TENANT_ID:0:8}"
RUNTIME_URL=$(gcloud run services describe "tenant-runtime-${SHORT_ID}" --format='value(status.url)')
TOKEN=$(gcloud auth print-identity-token)

SANDBOX_ID=$(curl -fsS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"agentId":"test-agent","capabilities":["shell","file","browser","vscode"]}' \
  "$RUNTIME_URL/internal/sandbox/test-provision" | jq -r .sandboxId)

for tool in shell_exec file_write file_read browser_navigate vscode_get_url mcp_list_tools; do
  RESULT=$(curl -fsS -X POST \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d "{\"sandboxId\":\"$SANDBOX_ID\",\"tool\":\"$tool\",\"args\":{}}" \
    "$RUNTIME_URL/internal/sandbox/test-exec")
  if [[ $(echo "$RESULT" | jq -r .success) != "true" ]]; then
    echo "FAIL: $tool — $RESULT"
    exit 1
  fi
done

curl -fsS -X DELETE -H "Authorization: Bearer $TOKEN" "$RUNTIME_URL/internal/sandbox/test-destroy/$SANDBOX_ID"

echo "PASS: $TENANT_ID"
