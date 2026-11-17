// Codex CLI tests:
//   - v1 -> v2 state migration preserves an existing Claude connection
//   - Per-client state independence (claude vs codex)
//   - Profile generation/validation, backup, idempotency
//   - Dev-to-prod base URL mismatch rejection
//   - Catalog generation/validation
//   - Stable helper install: versioned, .prev rollback, no downgrade
//   - Credential-helper stdout purity (credential only; diagnostics on stderr)

import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpDir: string;

jest.mock('os', () => ({
  ...jest.requireActual('os'),
  homedir: () => tmpDir,
}));

// The credential-helper purity test exercises the documented 0600-file
// fallback, so the keychain branch must fail deterministically. Without this,
// any machine that has run `codex setup` for real has a proxy-codex
// keychain item, and the helper prints THAT credential instead of the test
// fixture — an environment-dependent failure that also leaks a real key into
// test output. Only the keychain binaries are stubbed; everything else passes
// through to the real child_process.
jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  return {
    ...actual,
    execFileSync: (cmd: string, ...rest: unknown[]) => {
      if (cmd === 'security' || cmd === 'secret-tool') {
        throw new Error('keychain unavailable in tests');
      }
      return actual.execFileSync(cmd, ...rest);
    },
  };
});

import {
  loadCliState,
  saveClientState,
  loadState,
  saveState,
} from '../state';
import {
  renderProfileToml,
  validateProfileToml,
  writeLiftoffProfile,
  writeModelCatalog,
  validateCatalog,
  liftoffProfilePath,
} from '../codex-config';
import { installStableHelper, helperPath, runCredentialHelper } from '../credential-helper';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function statePath(): string {
  return path.join(tmpDir, '.liftoff', 'proxy-state.json');
}

describe('state migration v1 -> v2', () => {
  it('migrates a legacy single-client state without losing the Claude connection', () => {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify({
      baseUrl: 'https://api-dev.example.com/proxy',
      apiKey: 'liftoff_sk_legacy',
      tenantId: 'tenant-1',
      connectedAt: '2026-01-01T00:00:00.000Z',
      mcpToken: 'liftoff_mcp_x',
    }));

    const migrated = loadCliState();
    expect(migrated.version).toBe(2);
    expect(migrated.clients.claude?.apiKey).toBe('liftoff_sk_legacy');
    expect(migrated.clients.claude?.tenantId).toBe('tenant-1');
    expect(migrated.clients.claude?.mcpToken).toBe('liftoff_mcp_x');
    expect(migrated.clients.codex).toBeUndefined();

    // Legacy API still reads the migrated Claude client.
    expect(loadState()?.apiKey).toBe('liftoff_sk_legacy');

    // The migrated form is persisted.
    const onDisk = JSON.parse(fs.readFileSync(statePath(), 'utf-8'));
    expect(onDisk.version).toBe(2);
  });

  it('keeps Claude and Codex state independent', () => {
    saveState({
      baseUrl: 'https://api-dev.example.com/proxy',
      apiKey: 'liftoff_sk_claude',
      tenantId: 'tenant-1',
      connectedAt: '2026-01-01T00:00:00.000Z',
    });
    saveClientState('codex', {
      baseUrl: 'https://api-dev.example.com/proxy',
      credentialRef: 'keychain',
      tenantId: 'tenant-1',
      connectedAt: '2026-02-01T00:00:00.000Z',
      paused: true,
      installedClientVersion: '0.144.6',
    });

    const state = loadCliState();
    expect(state.clients.claude?.apiKey).toBe('liftoff_sk_claude');
    expect(state.clients.claude?.paused).toBe(false);
    expect(state.clients.codex?.paused).toBe(true);
    expect(state.clients.codex?.credentialRef).toBe('keychain');

    // Claude write does not clobber Codex.
    saveState({
      baseUrl: 'https://api-dev.example.com/proxy',
      apiKey: 'liftoff_sk_claude2',
      tenantId: 'tenant-1',
      connectedAt: '2026-03-01T00:00:00.000Z',
    });
    expect(loadCliState().clients.codex?.paused).toBe(true);
  });
});

describe('profile generation', () => {
  const input = {
    proxyBaseUrl: 'https://api-dev.example.com/proxy',
    defaultModel: 'gpt-5.6-sol',
    catalogFile: '/home/u/.liftoff/codex-models.json',
    helperPath: '/home/u/.liftoff/bin/credential-helper',
  };

  it('renders a valid dedicated profile with the environment base URL', () => {
    const toml = renderProfileToml(input);
    expect(() => validateProfileToml(toml)).not.toThrow();
    expect(toml).toContain('base_url = "https://api-dev.example.com/proxy/codex/v1"');
    expect(toml).toContain('supports_websockets = false');
    expect(toml).toContain('command = "/home/u/.liftoff/bin/credential-helper"');
    expect(toml).toContain('OpenAI Platform API');
  });

  it('is idempotent and backs up an existing differing profile', () => {
    const first = writeLiftoffProfile({ input, environment: 'dev' });
    expect(first.changed).toBe(true);
    const second = writeLiftoffProfile({ input, environment: 'dev' });
    expect(second.changed).toBe(false);
    expect(fs.existsSync(`${liftoffProfilePath()}.bak`)).toBe(false);

    const third = writeLiftoffProfile({
      input: { ...input, defaultModel: 'gpt-5.6-luna' },
      environment: 'dev',
    });
    expect(third.changed).toBe(true);
    expect(fs.existsSync(`${liftoffProfilePath()}.bak`)).toBe(true);
    // Backup holds the previous content.
    expect(fs.readFileSync(`${liftoffProfilePath()}.bak`, 'utf-8')).toContain('gpt-5.6-sol');
  });

  it('rejects a dev profile pointing at the production proxy URL', () => {
    expect(() =>
      writeLiftoffProfile({
        input: { ...input, proxyBaseUrl: 'https://api.example.com/proxy' },
        environment: 'dev',
      }),
    ).toThrow(/production proxy URL/);
  });

  it('never touches the default Codex profile', () => {
    const defaultProfile = path.join(tmpDir, '.codex', 'config.toml');
    fs.mkdirSync(path.dirname(defaultProfile), { recursive: true });
    fs.writeFileSync(defaultProfile, '# user default\n');
    writeLiftoffProfile({ input, environment: 'dev' });
    expect(fs.readFileSync(defaultProfile, 'utf-8')).toBe('# user default\n');
  });
});

describe('model catalog', () => {
  it('writes reviewed server metadata VERBATIM and invents nothing', () => {
    const file = writeModelCatalog(
      [
        { id: 'gpt-5.6-sol', metadata: { api: 'responses', context_window: 400000 } },
        { id: 'gpt-5.6-luna' }, // no reviewed metadata -> minimal entry
      ],
      '0.144.6',
    );
    expect(() => validateCatalog(file)).not.toThrow();
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(parsed.models).toHaveLength(2);
    expect(parsed.models[0]).toEqual({ id: 'gpt-5.6-sol', api: 'responses', context_window: 400000 });
    // No invented capability fields on the metadata-less model.
    expect(parsed.models[1]).toEqual({ id: 'gpt-5.6-luna' });
    expect(parsed.codex_version).toBe('0.144.6');
  });

  it('rejects an empty catalog', () => {
    const file = writeModelCatalog([], null);
    expect(() => validateCatalog(file)).toThrow(/no models/);
  });
});

describe('stable credential helper', () => {
  it('installs a versioned self-contained helper under ~/.liftoff/bin', () => {
    const result = installStableHelper();
    expect(result.installed).toBe(true);
    const content = fs.readFileSync(helperPath(), 'utf-8');
    expect(content.startsWith('#!/usr/bin/env node')).toBe(true);
    expect(content).toContain(`credential-helper v${result.version}`);
    // The runtime auth path must never INVOKE npx or the network (the
    // diagnostic string may mention the setup command).
    expect(content).not.toMatch(/execFileSync\(['"]npx/);
    expect(content).not.toContain('fetch(');
    expect(content).not.toContain("require('http");
    const mode = fs.statSync(helperPath()).mode & 0o777;
    expect(mode).toBe(0o755);
  });

  it('keeps a .prev rollback copy and never downgrades', () => {
    // Pretend a newer helper is already installed.
    fs.mkdirSync(path.dirname(helperPath()), { recursive: true });
    fs.writeFileSync(helperPath(), '#!/usr/bin/env node\n// credential-helper v999.0.0\n', { mode: 0o755 });
    const result = installStableHelper();
    expect(result.installed).toBe(false);
    expect(result.version).toBe('999.0.0');

    // An OLDER installed helper is upgraded, with rollback preserved.
    fs.writeFileSync(helperPath(), '#!/usr/bin/env node\n// credential-helper v0.0.1\n', { mode: 0o755 });
    const upgraded = installStableHelper();
    expect(upgraded.installed).toBe(true);
    expect(fs.readFileSync(`${helperPath()}.prev`, 'utf-8')).toContain('v0.0.1');
  });
});

describe('credential-helper stdout purity', () => {
  it('prints ONLY the credential to stdout; diagnostics go to stderr', () => {
    // Force the file fallback backend.
    const credDir = path.join(tmpDir, '.liftoff', 'credentials');
    fs.mkdirSync(credDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(credDir, 'codex'), 'liftoff_sk_codexkey\n', { mode: 0o600 });

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const outSpy = jest.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
      stdoutChunks.push(String(c));
      return true;
    });
    const errSpy = jest.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
      stderrChunks.push(String(c));
      return true;
    });
    try {
      // darwin keychain lookup will fail for this service; the helper falls
      // back to the 0600 file.
      const code = runCredentialHelper('codex');
      expect(code).toBe(0);
    } finally {
      outSpy.mockRestore();
      errSpy.mockRestore();
    }
    expect(stdoutChunks.join('')).toBe('liftoff_sk_codexkey');

    // Missing credential: stdout stays EMPTY, error goes to stderr.
    fs.rmSync(path.join(credDir, 'codex'));
    const out2: string[] = [];
    const err2: string[] = [];
    const outSpy2 = jest.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => { out2.push(String(c)); return true; });
    const errSpy2 = jest.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => { err2.push(String(c)); return true; });
    try {
      const code = runCredentialHelper('codex');
      expect(code).toBe(1);
    } finally {
      outSpy2.mockRestore();
      errSpy2.mockRestore();
    }
    expect(out2.join('')).toBe('');
    expect(err2.join('')).toContain('no stored credential');
  });
});
