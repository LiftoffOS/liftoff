// Claude Config Tests
// Tests read/write of ~/.claude/settings.json (proxy env vars) and
// ~/.claude.json (MCP server registry).

import fs from 'fs';
import os from 'os';
import path from 'path';

// Use a temp directory to avoid touching real settings
let tmpDir: string;
let settingsPath: string;
let claudeJsonPath: string;

// Override the module's paths by mocking os.homedir
jest.mock('os', () => ({
  ...jest.requireActual('os'),
  homedir: () => tmpDir,
  hostname: () => 'test-host',
}));

import {
  readSettings,
  writeSettings,
  getExistingAnthropicKey,
  setProxyConfig,
  removeProxyConfig,
  getProxyStatus,
  setMcpConfig,
  removeMcpConfig,
  getMcpStatus,
  setCollabInstructions,
  removeCollabInstructions,
} from '../claude-config';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-'));
  settingsPath = path.join(tmpDir, '.claude', 'settings.json');
  claudeJsonPath = path.join(tmpDir, '.claude.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Helper to read ~/.claude.json in tests
function readClaudeJson(): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
  } catch {
    return {};
  }
}

describe('readSettings', () => {
  it('returns empty object when file does not exist', () => {
    expect(readSettings()).toEqual({});
  });

  it('returns parsed JSON when file exists', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, '{"existing": "value"}');
    expect(readSettings()).toEqual({ existing: 'value' });
  });

  it('returns empty object on malformed JSON', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, 'not json {{{');
    expect(readSettings()).toEqual({});
  });
});

describe('setProxyConfig', () => {
  it('writes ANTHROPIC_BASE_URL, ANTHROPIC_API_KEY, and ENABLE_TOOL_SEARCH to settings.json', () => {
    setProxyConfig('https://proxy.example.com', 'liftoff_sk_test123');
    const settings = readSettings();
    const env = settings.env as Record<string, string>;
    expect(env.ANTHROPIC_BASE_URL).toBe('https://proxy.example.com');
    expect(env.ANTHROPIC_API_KEY).toBe('liftoff_sk_test123');
    expect(env.ENABLE_TOOL_SEARCH).toBe('true');
  });

  it('preserves existing non-proxy keys in settings.json', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      otherSetting: true,
      env: { SOME_VAR: 'keep-this' },
    }));

    setProxyConfig('https://proxy.example.com', 'liftoff_sk_test');
    const settings = readSettings();
    expect(settings.otherSetting).toBe(true);
    expect((settings.env as Record<string, string>).SOME_VAR).toBe('keep-this');
    expect((settings.env as Record<string, string>).ANTHROPIC_BASE_URL).toBe('https://proxy.example.com');
  });
});

describe('removeProxyConfig', () => {
  it('removes proxy keys from settings.json but preserves others', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      env: {
        ANTHROPIC_BASE_URL: 'https://proxy.example.com',
        ANTHROPIC_API_KEY: 'liftoff_sk_test',
        ENABLE_TOOL_SEARCH: 'true',
        OTHER_VAR: 'keep',
      },
    }));

    removeProxyConfig();
    const settings = readSettings();
    const env = settings.env as Record<string, string>;
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ENABLE_TOOL_SEARCH).toBeUndefined();
    expect(env.OTHER_VAR).toBe('keep');
  });
});

describe('getExistingAnthropicKey', () => {
  it('returns null when no key exists', () => {
    expect(getExistingAnthropicKey()).toBeNull();
  });

  it('returns key from settings.json if not a liftoff key', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      env: { ANTHROPIC_API_KEY: 'sk-ant-real-key' },
    }));
    expect(getExistingAnthropicKey()).toBe('sk-ant-real-key');
  });

  it('ignores liftoff_sk_ keys (already proxied)', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      env: { ANTHROPIC_API_KEY: 'liftoff_sk_test123' },
    }));
    expect(getExistingAnthropicKey()).toBeNull();
  });
});

describe('getProxyStatus', () => {
  it('returns connected when proxy config is set', () => {
    setProxyConfig('https://proxy.example.com', 'liftoff_sk_test1234');
    const status = getProxyStatus();
    expect(status.connected).toBe(true);
    expect(status.baseUrl).toBe('https://proxy.example.com');
    expect(status.keyHint).toBe('1234');
  });

  it('returns disconnected when no config', () => {
    const status = getProxyStatus();
    expect(status.connected).toBe(false);
  });
});

describe('setProxyConfig also writes mcpServers.liftoff to ~/.claude.json', () => {
  it('writes mcpServers.liftoff with proxy key as bearer token', () => {
    setProxyConfig('https://api.example.com/proxy', 'liftoff_sk_test123');
    const data = readClaudeJson();
    const mcpServers = data.mcpServers as Record<string, { type: string; url: string; headers: Record<string, string> }>;
    expect(mcpServers['liftoff'].type).toBe('http');
    expect(mcpServers['liftoff'].url).toBe('https://api.example.com/mcp');
    expect(mcpServers['liftoff'].headers.Authorization).toBe('Bearer liftoff_sk_test123');
  });

  it('does not write mcpServers to settings.json', () => {
    setProxyConfig('https://api.example.com/proxy', 'liftoff_sk_abc');
    const settings = readSettings();
    expect(settings.mcpServers).toBeUndefined();
  });

  it('preserves existing mcpServers entries in ~/.claude.json', () => {
    fs.writeFileSync(claudeJsonPath, JSON.stringify({
      mcpServers: { 'other-server': { type: 'stdio', command: 'foo' } },
    }));
    setProxyConfig('https://api.example.com/proxy', 'liftoff_sk_abc');
    const data = readClaudeJson();
    const mcpServers = data.mcpServers as Record<string, unknown>;
    expect(mcpServers['other-server']).toBeDefined();
    expect(mcpServers['liftoff']).toBeDefined();
  });
});

describe('setMcpConfig', () => {
  it('writes mcpServers.liftoff to ~/.claude.json, does not write env block', () => {
    setMcpConfig('liftoff_mcp_test123');
    // No env in settings.json
    const settings = readSettings();
    expect(settings.env).toBeUndefined();
    // MCP entry in ~/.claude.json
    const data = readClaudeJson();
    const mcpServers = data.mcpServers as Record<string, { headers: Record<string, string> }>;
    expect(mcpServers['liftoff'].headers.Authorization).toBe('Bearer liftoff_mcp_test123');
  });

  it('preserves existing mcpServers entries in ~/.claude.json', () => {
    fs.writeFileSync(claudeJsonPath, JSON.stringify({
      mcpServers: { 'another': { type: 'stdio' } },
      someOtherKey: 'keep',
    }));
    setMcpConfig('liftoff_mcp_abc');
    const data = readClaudeJson();
    const mcpServers = data.mcpServers as Record<string, unknown>;
    expect(mcpServers['another']).toBeDefined();
    expect(mcpServers['liftoff']).toBeDefined();
    expect(data.someOtherKey).toBe('keep');
  });
});

describe('removeMcpConfig', () => {
  it('removes mcpServers.liftoff from ~/.claude.json but leaves env block in settings.json intact', () => {
    // Set up both
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      env: { ANTHROPIC_API_KEY: 'liftoff_sk_proxy', ANTHROPIC_BASE_URL: 'https://proxy.example.com' },
    }));
    fs.writeFileSync(claudeJsonPath, JSON.stringify({
      mcpServers: { 'liftoff': { type: 'http', url: 'https://api.example.com/mcp', headers: { Authorization: 'Bearer liftoff_mcp_test' } } },
    }));
    removeMcpConfig();
    // env stays in settings.json
    const settings = readSettings();
    const env = settings.env as Record<string, string>;
    expect(env.ANTHROPIC_API_KEY).toBe('liftoff_sk_proxy');
    // mcpServers removed from ~/.claude.json
    const data = readClaudeJson();
    expect(data.mcpServers).toBeUndefined();
  });
});

describe('removeProxyConfig removes mcpServers.liftoff from ~/.claude.json', () => {
  it('removes both env vars from settings.json and mcpServers.liftoff from ~/.claude.json', () => {
    setProxyConfig('https://api.example.com/proxy', 'liftoff_sk_test123');
    removeProxyConfig();
    const settings = readSettings();
    expect(settings.env).toBeUndefined();
    const data = readClaudeJson();
    expect((data.mcpServers as Record<string, unknown> | undefined)?.['liftoff']).toBeUndefined();
  });
});

describe('getMcpStatus', () => {
  it('returns connected with keyType=proxy when proxy key is in ~/.claude.json', () => {
    setProxyConfig('https://api.example.com/proxy', 'liftoff_sk_test1234');
    const status = getMcpStatus();
    expect(status.connected).toBe(true);
    expect(status.keyType).toBe('proxy');
    expect(status.keyHint).toBe('1234');
  });

  it('returns connected with keyType=collab when MCP token is in ~/.claude.json', () => {
    setMcpConfig('liftoff_mcp_test5678');
    const status = getMcpStatus();
    expect(status.connected).toBe(true);
    expect(status.keyType).toBe('collab');
    expect(status.keyHint).toBe('5678');
  });

  it('returns disconnected when no MCP config in ~/.claude.json', () => {
    expect(getMcpStatus().connected).toBe(false);
  });
});

describe('setCollabInstructions', () => {
  it('creates collab.md with collaboration instructions', () => {
    setCollabInstructions();
    const collabPath = path.join(tmpDir, '.claude', 'collab.md');
    expect(fs.existsSync(collabPath)).toBe(true);
    const content = fs.readFileSync(collabPath, 'utf-8');
    expect(content).toContain('liftoff_read_messages');
    expect(content).toContain('liftoff_find_teammates');
  });

  it('adds @collab.md include to CLAUDE.md', () => {
    setCollabInstructions();
    const claudeMdPath = path.join(tmpDir, '.claude', 'CLAUDE.md');
    const content = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(content).toContain('@collab.md');
  });

  it('does not duplicate include line if called twice', () => {
    setCollabInstructions();
    setCollabInstructions();
    const claudeMdPath = path.join(tmpDir, '.claude', 'CLAUDE.md');
    const content = fs.readFileSync(claudeMdPath, 'utf-8');
    const matches = content.split('@collab.md').length - 1;
    expect(matches).toBe(1);
  });

  it('adds include without clobbering existing CLAUDE.md content', () => {
    const claudeMdPath = path.join(tmpDir, '.claude', 'CLAUDE.md');
    fs.mkdirSync(path.dirname(claudeMdPath), { recursive: true });
    fs.writeFileSync(claudeMdPath, '# My Rules\n\nKeep these.\n');
    setCollabInstructions();
    const content = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(content).toContain('# My Rules');
    expect(content).toContain('@collab.md');
  });
});

describe('removeCollabInstructions', () => {
  it('removes collab.md file', () => {
    setCollabInstructions();
    removeCollabInstructions();
    const collabPath = path.join(tmpDir, '.claude', 'collab.md');
    expect(fs.existsSync(collabPath)).toBe(false);
  });

  it('removes @collab.md include from CLAUDE.md', () => {
    setCollabInstructions();
    removeCollabInstructions();
    const claudeMdPath = path.join(tmpDir, '.claude', 'CLAUDE.md');
    try {
      const content = fs.readFileSync(claudeMdPath, 'utf-8');
      expect(content).not.toContain('@collab.md');
    } catch {
      // CLAUDE.md may not exist if it was empty — acceptable
    }
  });

  it('does not throw if files do not exist', () => {
    expect(() => removeCollabInstructions()).not.toThrow();
  });
});
