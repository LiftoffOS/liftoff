#!/usr/bin/env bash
#
# CI fence: an MCP credential is revoked one person at a time, never by a deploy.
#
# Every coding tool connected to a workspace holds an OAuth grant (oauth_grants,
# oauth_access_tokens, oauth_refresh_tokens) anchored on an mcp_tokens row. A
# revocation signs that tool out and the person has to run the sign-in again.
# The legitimate reasons are one person's, or the registered client's own
# (RFC 7592): they disconnected the tool, the tool presented the token to
# /oauth/revoke (a grant left with no live refresh token is retired, since it
# can no longer mint), a refresh token was replayed, they were removed from
# the workspace, or the client sent DELETE to its registration_client_uri
# with the registration access token issued only at DCR — the client
# operator's own act, which signs out every person connected through that
# registration. Each of those statements is bound to one grant, token,
# membership or client_id by a query parameter.
#
# A release is never a reason. Tokens are opaque and resolved against the
# database on every call, and membership and role are re-read per call, so a
# credential minted before a rule obeys the rule from the first call after the
# deploy. When the identity model changes, the migration backfills the old
# rows; nothing revokes them. An estate-wide revocation on the belief that old
# tokens carry old authority is wrong -- they do not -- and signs every
# connected tool out for nothing.
#
# Revocation, issuance and the sweep cannot cycle because every path follows
# the lock discipline in the header of src/oauth/grant-lifecycle.ts: ascending
# tiers (client -> pending rows -> grant), grant-owned rows never locked on
# their own, multi-row locks in id order, request paths locking and writing
# only live rows, and a sweep that deletes only rows dead for an hour or more.
#
# Two rules:
#   1. Nothing under src/scripts/ or migrations/ revokes a credential. Those
#      directories run as an operator or as the deploy, and neither is a person.
#   2. Every revoking statement elsewhere in src/ carries a bound parameter, so
#      it names one grant, token, person or client and cannot be estate-wide.
#
# Usage:
#   scripts/ci-fences/credential-revocation-fence.sh [src-dir] [migrations-dir]
#
# Exit codes:
#   0 = clean
#   1 = a script or migration revokes credentials, or a statement is unbounded
#   2 = usage error

set -euo pipefail

SRC="${1:-src}"
MIG="${2:-migrations}"
if [[ ! -d "$SRC" || ! -d "$MIG" ]]; then
  echo "credential-revocation-fence: '$SRC' and '$MIG' must both be directories" >&2
  exit 2
fi

node - "$SRC" "$MIG" <<'JS'
const fs = require('fs');
const path = require('path');

const [src, mig] = process.argv.slice(2);
const TABLES = /\b(oauth_grants|oauth_access_tokens|oauth_refresh_tokens|mcp_tokens)\b/;
const REVOKES = /revoked_at\s*=\s*NOW\(\)|status\s*=\s*'revoked'/i;
// An UPDATE whose table is interpolated (`UPDATE ${table} ...`) is checked as
// if it named a credential table: the revoke route rotates between two of them.
const UPDATE_INTERPOLATED = /\bUPDATE\s+\$\{/;

function walk(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '__tests__') continue;
      walk(p, out);
    } else if (/\.(ts|js|mjs|cjs|sql)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

const violations = [];
const scriptsDir = path.join(src, 'scripts');

// Rule 1: no script, no migration.
for (const p of [...walk(scriptsDir, []), ...walk(mig, [])]) {
  const body = fs.readFileSync(p, 'utf8').replace(/--.*$/gm, '').replace(/\/\/.*$/gm, '');
  if (TABLES.test(body) && REVOKES.test(body)) {
    violations.push([p, 'revokes MCP credentials from a script or migration. Only a person\'s own action revokes a credential; a deploy or an operator never does.']);
  }
}

// Rule 2: every revoking statement is bound to one grant, token or person.
for (const p of walk(src, [])) {
  if (p.startsWith(scriptsDir + path.sep)) continue;
  const body = fs.readFileSync(p, 'utf8');
  for (const literal of body.match(/`[^`]*`/g) || []) {
    if (!/\bUPDATE\b/.test(literal) || !REVOKES.test(literal)) continue;
    if (!TABLES.test(literal) && !UPDATE_INTERPOLATED.test(literal)) continue;
    if (!/\$\d+/.test(literal)) {
      violations.push([p, 'revokes credentials with no bound parameter: nothing narrows the statement to one grant, token or person, so it is estate-wide.']);
    }
  }
}

for (const [file, why] of violations) {
  console.log(`FAIL  ${file}`);
  console.log(`      ${why}`);
  console.log('');
}
if (violations.length > 0) {
  console.error(`credential-revocation-fence: ${violations.length} violation(s) (see above).`);
  process.exit(1);
}
console.log('credential-revocation-fence: clean');
JS
