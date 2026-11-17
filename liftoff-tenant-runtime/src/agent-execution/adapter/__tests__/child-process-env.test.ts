// FITNESS FUNCTION — a process that runs agent-authored shell commands does not
// inherit this one's environment.
//
// The runtime hydrates fourteen secrets into `process.env` at boot: the Cloud
// SQL password, four service tokens, the Google OAuth client secret and every
// managed provider key. Every SDK here spawns its child inheriting that by
// default — the Claude Agent SDK and the Codex SDK both say so in their own
// docs — and the child is the one holding the agent's Bash tool. `printenv` in
// a coding session printed all fourteen into the transcript.
//
// Two things are pinned here, and the second is the one that rots:
//   1. `childProcessEnv()` returns an allow-list and nothing else.
//   2. Every spawn site USES it. A new coding runner that spawns with the
//      default environment is the way this comes back, so the sites are
//      enumerated rather than trusted.

import { readFileSync } from 'fs';
import { join } from 'path';
import { _CHILD_ENV_ALLOW_LIST, childProcessEnv } from '../child-process-env';

const ADAPTER_ROOT = join(__dirname, '..');

/** The secrets `loadSecretsToEnv` puts on this process. None may reach a child. */
const RUNTIME_SECRETS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_API_KEY_AGENT_EXECUTION',
  'OPENAI_API_KEY_BACKGROUND_SERVICES',
  'OPENAI_API_KEY_PLATFORM_ANALYTICS',
  'OPENAI_API_KEY_REFLECTIVE_SERVICES',
  'OPENROUTER_API_KEY',
  'DB_PASSWORD',
  'CONNECTOR_SERVICE_TOKEN',
  'PLATFORM_CALLBACK_TOKEN',
  'TENANT_RUNTIME_SERVICE_TOKEN',
  'GOVERNANCE_SERVICE_TOKEN',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
];

describe('childProcessEnv', () => {
  const ORIGINAL = { ...process.env };

  beforeEach(() => {
    for (const name of RUNTIME_SECRETS) process.env[name] = `secret-value-for-${name}`;
    process.env.PATH = '/usr/local/bin:/usr/bin';
    process.env.HOME = '/home/agent';
  });
  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  it('withholds every secret this process holds', () => {
    const env = childProcessEnv();
    for (const name of RUNTIME_SECRETS) {
      expect(env).not.toHaveProperty(name);
    }
    // Belt and braces: not under another name either.
    expect(Object.values(env).some((v) => v.startsWith('secret-value-for-'))).toBe(false);
  });

  it('passes through what a CLI genuinely needs', () => {
    const env = childProcessEnv();
    expect(env.PATH).toBe('/usr/local/bin:/usr/bin');
    expect(env.HOME).toBe('/home/agent');
  });

  it('omits an allow-listed variable this process does not have, rather than passing undefined', () => {
    delete process.env.TZ;
    expect(childProcessEnv()).not.toHaveProperty('TZ');
  });

  it('carries the gateway credential a caller adds', () => {
    const env = childProcessEnv({
      ANTHROPIC_BASE_URL: 'https://api.example.com/byok/anthropic',
      ANTHROPIC_AUTH_TOKEN: 'liftoff_byok_run_token',
    });
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.example.com/byok/anthropic');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('liftoff_byok_run_token');
  });

  it('drops an undefined addition rather than passing the string "undefined"', () => {
    // A vendor CLI handed the literal string "undefined" tries to authenticate
    // with it and fails in a way that reads as a provider outage.
    const env = childProcessEnv({ ANTHROPIC_API_KEY: undefined });
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY');
  });

  it('keeps the allow-list short, so growth is a deliberate act', () => {
    // Not a style rule. Every entry is a decision that something the child can
    // read is safe for it to read, and a list that grows casually stops being
    // one. Adding a variable means adding it here with a reason.
    expect([..._CHILD_ENV_ALLOW_LIST].sort()).toEqual([
      'HOME',
      'LANG',
      'LC_ALL',
      'NODE_EXTRA_CA_CERTS',
      'PATH',
      'SSL_CERT_DIR',
      'SSL_CERT_FILE',
      'TMP',
      'TMPDIR',
      'TZ',
    ]);
  });

  it('carries no credential of its own', () => {
    for (const name of _CHILD_ENV_ALLOW_LIST) {
      expect(name).not.toMatch(/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i);
    }
  });
});

describe('every spawn site uses it', () => {
  /** Files that spawn a process which runs agent-authored commands. */
  const SPAWN_SITES = [
    'anthropic/index.ts',
    'codex/index.ts',
    'gemini-cli/index.ts',
    // The opencode server: spawned by this adapter rather than the SDK, whose
    // ServerOptions has no `env`. What the server's environment carries is
    // also what decides the API opencode reaches a provider over.
    'opencode/server.ts',
    'tools/code-session/runners/anthropic.ts',
    'tools/code-session/runners/openai.ts',
    'tools/code-session/runners/openrouter.ts',
    'tools/code-session/runners/gemini.ts',
  ];

  /** Spawn sites that cannot be allow-listed, by name, with the reason. None
   *  today; the entry the opencode SDK's missing `env` option once earned is
   *  closed by spawning that server here. */
  const CANNOT_ALLOW_LIST: Record<string, string> = {};

  it.each(SPAWN_SITES)('%s builds its child environment explicitly', (relative) => {
    const source = readFileSync(join(ADAPTER_ROOT, relative), 'utf8');
    expect(source).toContain('childProcessEnv(');
  });

  it.each(SPAWN_SITES)('%s never spreads this process environment into a child', (relative) => {
    const source = readFileSync(join(ADAPTER_ROOT, relative), 'utf8');
    // The shape the SDK's own example suggests, and the shape that put fourteen
    // secrets in front of the agent's shell.
    expect(source).not.toMatch(/env:\s*\{\s*\.\.\.process\.env/);
    expect(source).not.toMatch(/env:\s*process\.env\b/);
  });

  it('has an exception list that names only what is really blocked', () => {
    for (const [relative, reason] of Object.entries(CANNOT_ALLOW_LIST)) {
      expect(readFileSync(join(ADAPTER_ROOT, relative), 'utf8')).toBeTruthy();
      expect(reason).toBeTruthy();
      // An exception must not also be in the enforced list.
      expect(SPAWN_SITES).not.toContain(relative);
    }
  });

  it('starts the opencode server itself rather than through the SDK, which would inherit this environment', () => {
    const adapter = readFileSync(join(ADAPTER_ROOT, 'opencode/index.ts'), 'utf8');
    // A call, not a mention: the header may still name the SDK's function to
    // say why it is not used.
    expect(adapter).not.toMatch(/await createOpencode\(/);
    expect(adapter).toContain('await startOpencode(');
  });
});
