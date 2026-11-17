// Local state persistence (~/.liftoff/proxy-state.json)
// Security: directory 0700, file 0600 (SE-003)
//
// Plan D1: versioned multi-client state. v1 was a single-client (Claude)
// shape; v2 is { version: 2, clients: { claude?, codex? } } with connection
// state, credential reference, profile path, installed client version,
// paused state, and environment base URL stored INDEPENDENTLY per client.
// Migration from v1 preserves an existing Claude connection losslessly.

import fs from 'fs';
import path from 'path';
import os from 'os';

function getStateDir(): string {
  return path.join(os.homedir(), '.liftoff');
}

function getStatePath(): string {
  return path.join(getStateDir(), 'proxy-state.json');
}

// ── v1 (legacy single-client) shape ────────────────────────────────────

export interface ProxyState {
  baseUrl: string;
  apiKey: string;
  tenantId: string;
  connectedAt: string;
  // Optional MCP-only token (set when liftoff collab is used)
  mcpToken?: string;
  mcpTokenId?: string;
}

// ── v2 (multi-client) shape ────────────────────────────────────────────

export type CliClient = 'claude' | 'codex';

export interface ClientState {
  /** Environment-specific proxy base URL from the setup response — never a
   *  synthesized production URL. */
  baseUrl: string;
  /** Credential reference: 'keychain' when the secret lives in the OS
   *  keychain, or the raw key for the legacy Claude flow.
   *
   *  DOCUMENTED TEMPORARY DIVERGENCE: Codex uses the keychain +
   *  stable helper from day one; Claude Code still stores the key inline in
   *  ~/.claude/settings.json (0600) because its pause/resume flow manipulates
   *  the ANTHROPIC_* env vars directly. REMOVAL MILESTONE: Codex GA
   * — migrate `claude setup` to keychain + the settings.json
   *  `apiKeyHelper` command and drop 'inline' support in the following
   *  release. */
  credentialRef: 'keychain' | 'inline';
  /** Present only for credentialRef === 'inline' (legacy Claude flow). */
  apiKey?: string;
  tenantId: string;
  connectedAt: string;
  paused: boolean;
  /** Generated profile path (codex: ~/.codex/liftoff.config.toml). */
  profilePath?: string;
  /** Local model catalog path (codex). */
  catalogPath?: string;
  /** Installed client version for compatibility diagnostics. */
  installedClientVersion?: string;
  // Claude-only MCP token (set when liftoff collab is used)
  mcpToken?: string;
  mcpTokenId?: string;
}

export interface CliState {
  version: 2;
  clients: Partial<Record<CliClient, ClientState>>;
}

function migrateV1(v1: ProxyState): CliState {
  return {
    version: 2,
    clients: {
      claude: {
        baseUrl: v1.baseUrl,
        credentialRef: 'inline',
        apiKey: v1.apiKey,
        tenantId: v1.tenantId,
        connectedAt: v1.connectedAt,
        paused: false,
        mcpToken: v1.mcpToken,
        mcpTokenId: v1.mcpTokenId,
      },
    },
  };
}

function writeStateFile(state: CliState): void {
  if (!fs.existsSync(getStateDir())) {
    fs.mkdirSync(getStateDir(), { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(getStatePath(), JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
}

export function loadCliState(): CliState {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(getStatePath(), 'utf-8'));
  } catch {
    return { version: 2, clients: {} };
  }
  const obj = raw as Record<string, unknown>;
  if (obj && obj.version === 2 && typeof obj.clients === 'object') {
    return obj as unknown as CliState;
  }
  // v1 single-client shape: migrate WITHOUT losing the Claude connection
  // and persist the migrated form.
  if (obj && typeof obj.apiKey === 'string' && typeof obj.baseUrl === 'string') {
    const migrated = migrateV1(obj as unknown as ProxyState);
    writeStateFile(migrated);
    return migrated;
  }
  return { version: 2, clients: {} };
}

export function saveClientState(client: CliClient, state: ClientState): void {
  const current = loadCliState();
  current.clients[client] = state;
  writeStateFile(current);
}

export function deleteClientState(client: CliClient): void {
  const current = loadCliState();
  delete current.clients[client];
  writeStateFile(current);
}

// ── Legacy single-client API (Claude) — kept for the existing flat
//    commands; reads/writes clients.claude through the v2 store. ─────────

export function saveState(state: ProxyState): void {
  const current = loadCliState();
  const existing = current.clients.claude;
  saveClientState('claude', {
    baseUrl: state.baseUrl,
    credentialRef: 'inline',
    apiKey: state.apiKey,
    tenantId: state.tenantId,
    connectedAt: state.connectedAt,
    paused: existing?.paused ?? false,
    mcpToken: state.mcpToken ?? existing?.mcpToken,
    mcpTokenId: state.mcpTokenId ?? existing?.mcpTokenId,
  });
}

export function loadState(): ProxyState | null {
  const claude = loadCliState().clients.claude;
  if (!claude || !claude.apiKey) return null;
  return {
    baseUrl: claude.baseUrl,
    apiKey: claude.apiKey,
    tenantId: claude.tenantId,
    connectedAt: claude.connectedAt,
    mcpToken: claude.mcpToken,
    mcpTokenId: claude.mcpTokenId,
  };
}

export function deleteState(): void {
  deleteClientState('claude');
}
