#!/usr/bin/env bash
# extract-spki-pins.sh
#
# Extracts SPKI SHA-256 fingerprints for the vendor MCP endpoints listed in
# src/security/mcp-url-guard.ts. Run this before production deployment and
# populate the spkiPinsSha256 arrays in that file.
#
# Prerequisites: openssl, xxd or sha256sum, base64 (standard on macOS/Linux)
#
# Usage:
#   chmod +x scripts/ops/extract-spki-pins.sh
#   ./scripts/ops/extract-spki-pins.sh
#
# Output: one base64-encoded SPKI SHA-256 hash per vendor endpoint.
# Copy each value into the corresponding spkiPinsSha256 array in mcp-url-guard.ts.
#
# NOTE: Re-run this script whenever a vendor rotates their certificate.
# Commit the updated fingerprints. Verify against a second independent
# connection (different network/IP) to guard against MITM during extraction.

set -euo pipefail

VENDORS=(
  "mcp.stripe.com:443"
  "mcp.hubspot.com:443"
  "api.github.com:443"
  "mcp.github.com:443"
  "mcp.notion.com:443"
  "mcp.intuit.com:443"
  "mcp.xero.com:443"
  "mcp.intercom.com:443"
)

extract_spki_pin() {
  local host_port="$1"
  local host="${host_port%%:*}"
  local port="${host_port##*:}"

  echo "Extracting SPKI for ${host}:${port}..."

  # Fetch certificate chain and extract leaf cert SPKI
  local spki_b64
  spki_b64=$(echo "" | openssl s_client -connect "${host}:${port}" \
    -servername "${host}" \
    2>/dev/null \
    | openssl x509 -pubkey -noout 2>/dev/null \
    | openssl pkey -pubin -outform der 2>/dev/null \
    | openssl dgst -sha256 -binary 2>/dev/null \
    | base64)

  echo "  hostname: '${host}', spkiPinsSha256: ['${spki_b64}']"
  echo ""
}

echo "=============================="
echo "SPKI PIN EXTRACTION RESULTS"
echo "Date: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
echo "=============================="
echo ""
echo "Paste these values into src/security/mcp-url-guard.ts:"
echo ""

for vendor in "${VENDORS[@]}"; do
  extract_spki_pin "${vendor}" || echo "  ERROR: could not connect to ${vendor} (skipping)"
done

echo "=============================="
echo "IMPORTANT: Verify these pins from a second independent network before committing."
echo "=============================="
