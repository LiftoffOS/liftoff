// Read/write Claude Code config files and related collaboration config files
// Manages Claude Code proxy configuration and Liftoff MCP collaboration setup
//
// File roles:
//   ~/.claude/settings.json — env vars, hooks, permissions (proxy config lives here)
//   ~/.claude.json          — MCP server registry (mcpServers key, read by Claude Code)
//   ~/.claude/CLAUDE.md     — global instructions loaded into every Claude Code session

import fs from 'fs';
import path from 'path';
import os from 'os';

function getClaudeDir(): string {
  return path.join(os.homedir(), '.claude');
}

function getSettingsPath(): string {
  return path.join(getClaudeDir(), 'settings.json');
}

// ~/.claude.json is the file Claude Code reads mcpServers from (user-level MCP registry)
function getClaudeJsonPath(): string {
  return path.join(os.homedir(), '.claude.json');
}

function getCollabInstructionsPath(): string {
  return path.join(getClaudeDir(), 'collab.md');
}

function getClaudeMdPath(): string {
  return path.join(getClaudeDir(), 'CLAUDE.md');
}

export function readSettings(): Record<string, unknown> {
  try {
    const content = fs.readFileSync(getSettingsPath(), 'utf-8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

export function writeSettings(settings: Record<string, unknown>): void {
  const dir = getClaudeDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const settingsPath = getSettingsPath();
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  // Restrict to owner-read/write only (SE-003)
  fs.chmodSync(settingsPath, 0o600);
}

// ~/.claude.json — MCP server registry (Claude Code's authoritative mcpServers location)
function readClaudeJson(): Record<string, unknown> {
  try {
    const content = fs.readFileSync(getClaudeJsonPath(), 'utf-8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

function writeClaudeJson(data: Record<string, unknown>): void {
  const claudeJsonPath = getClaudeJsonPath();
  fs.writeFileSync(claudeJsonPath, JSON.stringify(data, null, 2) + '\n');
  // Preserve 0600 permissions (Claude Code sets this; enforce on create)
  fs.chmodSync(claudeJsonPath, 0o600);
}

export function getExistingAnthropicKey(): string | null {
  // Check settings.json first
  const settings = readSettings();
  const env = settings.env as Record<string, string> | undefined;
  if (env?.ANTHROPIC_API_KEY && !env.ANTHROPIC_API_KEY.startsWith('liftoff_sk_')) {
    return env.ANTHROPIC_API_KEY;
  }
  // Check environment variable
  const envKey = process.env.ANTHROPIC_API_KEY;
  if (envKey && !envKey.startsWith('liftoff_sk_')) {
    return envKey;
  }
  return null;
}

// ── Proxy config (liftoff_sk_* — dual-use: proxy + MCP) ───────────────

export function setProxyConfig(baseUrl: string, apiKey: string): void {
  // Env vars (proxy routing) go in settings.json
  const settings = readSettings();
  const env = (settings.env as Record<string, string>) || {};
  env.ANTHROPIC_BASE_URL = baseUrl;
  env.ANTHROPIC_API_KEY = apiKey;
  env.ENABLE_TOOL_SEARCH = 'true';
  settings.env = env;
  writeSettings(settings);

  // MCP server registration goes in ~/.claude.json (proxy key is valid on /mcp too)
  setMcpEntryInClaudeJson(apiKey);
  setCollabInstructions();
}

export function removeProxyConfig(): void {
  // Remove env vars from settings.json
  const settings = readSettings();
  const env = settings.env as Record<string, string> | undefined;
  if (env) {
    delete env.ANTHROPIC_BASE_URL;
    delete env.ANTHROPIC_API_KEY;
    delete env.ENABLE_TOOL_SEARCH;
    if (Object.keys(env).length === 0) {
      delete settings.env;
    }
  }
  writeSettings(settings);

  // Remove MCP entry from ~/.claude.json
  removeMcpEntryFromClaudeJson();
  removeCollabInstructions();
}

export interface ProxyStatus {
  connected: boolean;
  baseUrl?: string;
  keyHint?: string;
}

export function getProxyStatus(): ProxyStatus {
  const settings = readSettings();
  const env = settings.env as Record<string, string> | undefined;
  if (env?.ANTHROPIC_BASE_URL && env?.ANTHROPIC_API_KEY?.startsWith('liftoff_sk_')) {
    return {
      connected: true,
      baseUrl: env.ANTHROPIC_BASE_URL,
      keyHint: env.ANTHROPIC_API_KEY.slice(-4),
    };
  }
  return { connected: false };
}

// ── MCP-only config (liftoff_mcp_* — collab without proxy) ────────────

export function setMcpConfig(mcpToken: string): void {
  setMcpEntryInClaudeJson(mcpToken);
  setCollabInstructions();
}

export function removeMcpConfig(): void {
  removeMcpEntryFromClaudeJson();
  removeCollabInstructions();
}

// Shared helpers: read/modify/write the mcpServers.liftoff entry in ~/.claude.json

function setMcpEntryInClaudeJson(token: string): void {
  const data = readClaudeJson();
  const mcpServers = (data.mcpServers as Record<string, unknown>) || {};
  mcpServers['liftoff'] = {
    type: 'http',
    url: 'https://api.example.com/mcp',
    headers: { Authorization: `Bearer ${token}` },
  };
  data.mcpServers = mcpServers;
  writeClaudeJson(data);
}

function removeMcpEntryFromClaudeJson(): void {
  const data = readClaudeJson();
  const mcpServers = data.mcpServers as Record<string, unknown> | undefined;
  if (mcpServers?.['liftoff']) {
    delete mcpServers['liftoff'];
    if (Object.keys(mcpServers).length === 0) {
      delete data.mcpServers;
    }
    writeClaudeJson(data);
  }
}

export interface McpStatus {
  connected: boolean;
  keyHint?: string;
  keyType?: 'proxy' | 'collab';
}

export function getMcpStatus(): McpStatus {
  const data = readClaudeJson();
  const mcpServers = data.mcpServers as Record<string, { headers?: { Authorization?: string } }> | undefined;
  const liftoff = mcpServers?.['liftoff'];
  if (!liftoff?.headers?.Authorization) return { connected: false };

  const token = liftoff.headers.Authorization.replace('Bearer ', '');
  if (token.startsWith('liftoff_sk_')) {
    return { connected: true, keyHint: token.slice(-4), keyType: 'proxy' };
  }
  if (token.startsWith('liftoff_mcp_')) {
    return { connected: true, keyHint: token.slice(-4), keyType: 'collab' };
  }
  return { connected: false };
}

// ── Collaboration instructions ─────────────────────────────────────────
// Written to ~/.claude/collab.md (not directly into CLAUDE.md)
// to limit blast radius — only affects Liftoff sessions.

const COLLAB_INCLUDE_LINE = '@collab.md';

const COLLAB_INSTRUCTIONS = `## Liftoff Collaboration

You are connected to the Liftoff platform as a collaboration participant.

At the start of every session:
1. Call \`liftoff_read_messages\` to check for pending tasks or messages from teammates and platform agents.
2. Call \`liftoff_read_context\` to search for relevant shared context before starting work.

During work:
- Use \`liftoff_find_teammates\` to discover specialist agents or other developers when you need help.
- Use \`liftoff_share_context\` when you discover something your teammates should know.
- Use \`liftoff_send_message\` to hand off information or request help from a specific teammate.
- Use \`liftoff_delegate_task\` to assign a task to a platform agent (requires delegation permission).

Messages sent to you are queued. There is no real-time push — check messages explicitly at session start or when switching tasks.
`;

export function setCollabInstructions(): void {
  const dir = getClaudeDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  // Write collab.md
  fs.writeFileSync(getCollabInstructionsPath(), COLLAB_INSTRUCTIONS, 'utf-8');

  // Add @include line to CLAUDE.md (create if absent; section-based to avoid clobbering)
  const claudeMdPath = getClaudeMdPath();
  let claudeMdContent = '';
  try {
    claudeMdContent = fs.readFileSync(claudeMdPath, 'utf-8');
  } catch {
    // CLAUDE.md doesn't exist yet — will create
  }

  if (!claudeMdContent.includes(COLLAB_INCLUDE_LINE)) {
    const separator = claudeMdContent.length > 0 && !claudeMdContent.endsWith('\n') ? '\n' : '';
    claudeMdContent = claudeMdContent + separator + COLLAB_INCLUDE_LINE + '\n';
    fs.writeFileSync(claudeMdPath, claudeMdContent, 'utf-8');
  }
}

export function removeCollabInstructions(): void {
  // Remove collab.md
  try {
    fs.unlinkSync(getCollabInstructionsPath());
  } catch {
    // File doesn't exist — fine
  }

  // Remove @include line from CLAUDE.md
  const claudeMdPath = getClaudeMdPath();
  try {
    const content = fs.readFileSync(claudeMdPath, 'utf-8');
    const updated = content
      .split('\n')
      .filter(line => line.trim() !== COLLAB_INCLUDE_LINE)
      .join('\n')
      .replace(/\n{3,}/g, '\n\n');
    if (updated !== content) {
      fs.writeFileSync(claudeMdPath, updated, 'utf-8');
    }
  } catch {
    // CLAUDE.md doesn't exist — nothing to remove
  }
}
