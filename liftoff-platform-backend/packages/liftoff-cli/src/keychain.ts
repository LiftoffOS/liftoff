// OS keychain storage for proxy credentials.
//
// Decided storage targets:
//   macOS   — the login Keychain via `security add/find/delete-generic-password`
//             (service: proxy-<client>, account: $USER).
//   Linux   — libsecret via `secret-tool` when available; otherwise the 0600
//             file fallback below.
//   Windows — 0600-equivalent file fallback (~/.liftoff/credentials/<client>);
//             Credential Manager integration is a documented follow-up.
//
// The 0600 file fallback (~/.liftoff/credentials/<client>) is used ONLY where
// keychain support is unavailable. No shell interpolation ever touches the
// credential: all invocations use execFile with argument arrays.

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

export type KeychainBackend = 'macos-keychain' | 'libsecret' | 'file';

function service(client: string): string {
  return `proxy-${client}`;
}

function fallbackDir(): string {
  return path.join(os.homedir(), '.liftoff', 'credentials');
}

function fallbackPath(client: string): string {
  return path.join(fallbackDir(), client);
}

function hasSecretTool(): boolean {
  try {
    execFileSync('secret-tool', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function detectBackend(): KeychainBackend {
  if (process.platform === 'darwin') return 'macos-keychain';
  if (process.platform === 'linux' && hasSecretTool()) return 'libsecret';
  return 'file';
}

export function storeCredential(client: string, credential: string): KeychainBackend {
  const backend = detectBackend();
  if (backend === 'macos-keychain') {
    // -U updates an existing item in place (rotation without profile rewrite).
    execFileSync(
      'security',
      ['add-generic-password', '-U', '-s', service(client), '-a', os.userInfo().username, '-w', credential],
      { stdio: 'ignore' },
    );
    return backend;
  }
  if (backend === 'libsecret') {
    execFileSync(
      'secret-tool',
      ['store', '--label', service(client), 'service', service(client), 'account', os.userInfo().username],
      { input: credential, stdio: ['pipe', 'ignore', 'ignore'] },
    );
    return backend;
  }
  // 0600 file fallback only where keychain support is unavailable.
  fs.mkdirSync(fallbackDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(fallbackPath(client), credential + '\n', { mode: 0o600 });
  return backend;
}

export function readCredential(client: string): string | null {
  const backend = detectBackend();
  try {
    if (backend === 'macos-keychain') {
      return execFileSync(
        'security',
        ['find-generic-password', '-s', service(client), '-a', os.userInfo().username, '-w'],
        { encoding: 'utf-8' },
      ).trim();
    }
    if (backend === 'libsecret') {
      return execFileSync(
        'secret-tool',
        ['lookup', 'service', service(client), 'account', os.userInfo().username],
        { encoding: 'utf-8' },
      ).trim();
    }
  } catch {
    // fall through to the file fallback
  }
  try {
    return fs.readFileSync(fallbackPath(client), 'utf-8').trim();
  } catch {
    return null;
  }
}

export function deleteCredential(client: string): void {
  try {
    if (process.platform === 'darwin') {
      execFileSync(
        'security',
        ['delete-generic-password', '-s', service(client), '-a', os.userInfo().username],
        { stdio: 'ignore' },
      );
    } else if (process.platform === 'linux' && hasSecretTool()) {
      execFileSync(
        'secret-tool',
        ['clear', 'service', service(client), 'account', os.userInfo().username],
        { stdio: 'ignore' },
      );
    }
  } catch {
    // item absent — fine
  }
  try {
    fs.unlinkSync(fallbackPath(client));
  } catch {
    // file absent — fine
  }
}
