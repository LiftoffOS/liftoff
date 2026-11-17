// Credential helper.
//
// Two pieces:
//   1. runCredentialHelper(client) — the in-process implementation invoked by
//      `liftoff credential-helper <client>`: prints ONLY the credential to
//      stdout; every diagnostic goes to stderr.
//   2. installStableHelper() — writes a versioned, SELF-CONTAINED Node script
//      to ~/.liftoff/bin/credential-helper during `codex setup`.
//      Codex invokes THAT script on every model request, so the runtime auth
//      command never depends on npx, network access, or the mutable npm
//      `latest` tag. Re-running setup from a newer package version
//      overwrites the helper only when its embedded version is newer; the
//      previous helper is kept as .prev for rollback.

import fs from 'fs';
import path from 'path';
import os from 'os';
import { readCredential } from './keychain.js';
import pkg from '../package.json';

export function runCredentialHelper(client: string): number {
  if (client !== 'codex' && client !== 'claude') {
    process.stderr.write(`liftoff credential-helper: unknown client "${client}"\n`);
    return 2;
  }
  const credential = readCredential(client);
  if (!credential) {
    process.stderr.write(
      `liftoff credential-helper: no stored credential for ${client}. Run "npx @liftoffos/cli ${client} setup".\n`,
    );
    return 1;
  }
  // stdout contains ONLY the credential.
  process.stdout.write(credential);
  return 0;
}

// ---------------------------------------------------------------------------
// Stable helper installation (~/.liftoff/bin)
// ---------------------------------------------------------------------------

export function helperDir(): string {
  return path.join(os.homedir(), '.liftoff', 'bin');
}

export function helperPath(): string {
  return path.join(helperDir(), 'credential-helper');
}

function embeddedHelperScript(version: string): string {
  // Self-contained: no imports beyond Node built-ins, no network, no npx.
  // Mirrors keychain.ts read logic (macOS security / libsecret / 0600 file).
  return `#!/usr/bin/env node
// credential-helper v${version} — installed by @liftoffos/cli codex setup.
// Prints ONLY the stored Liftoff proxy credential to stdout; diagnostics to
// stderr. Self-contained: no network, no npm, no shell interpolation.
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const client = process.argv[2];
if (client !== 'codex' && client !== 'claude') {
  process.stderr.write('credential-helper: usage: credential-helper <codex|claude>\\n');
  process.exit(2);
}
const service = 'proxy-' + client;
const account = os.userInfo().username;

function tryKeychain() {
  try {
    if (process.platform === 'darwin') {
      return execFileSync('security', ['find-generic-password', '-s', service, '-a', account, '-w'], { encoding: 'utf-8' }).trim();
    }
    if (process.platform === 'linux') {
      return execFileSync('secret-tool', ['lookup', 'service', service, 'account', account], { encoding: 'utf-8' }).trim();
    }
  } catch (_) { /* fall through */ }
  return null;
}

function tryFile() {
  try {
    return fs.readFileSync(path.join(os.homedir(), '.liftoff', 'credentials', client), 'utf-8').trim();
  } catch (_) { return null; }
}

const credential = tryKeychain() || tryFile();
if (!credential) {
  process.stderr.write('credential-helper: no stored credential for ' + client + '. Run "npx @liftoffos/cli ' + client + ' setup".\\n');
  process.exit(1);
}
process.stdout.write(credential);
`;
}

function installedHelperVersion(): string | null {
  try {
    const content = fs.readFileSync(helperPath(), 'utf-8');
    const match = content.match(/credential-helper v([\d.]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function versionGte(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/**
 * Install (or upgrade) the stable helper. Upgrade policy: a newer
 * package version replaces the helper and keeps the previous one at
 * `.prev` for rollback; an OLDER package never downgrades an existing helper.
 */
export function installStableHelper(): { path: string; installed: boolean; version: string } {
  const version = pkg.version as string;
  const existing = installedHelperVersion();
  if (existing && !versionGte(version, existing)) {
    return { path: helperPath(), installed: false, version: existing };
  }
  fs.mkdirSync(helperDir(), { recursive: true, mode: 0o700 });
  if (existing) {
    try {
      fs.copyFileSync(helperPath(), `${helperPath()}.prev`);
    } catch {
      // best-effort rollback copy
    }
  }
  fs.writeFileSync(helperPath(), embeddedHelperScript(version), { mode: 0o755 });
  return { path: helperPath(), installed: true, version };
}
