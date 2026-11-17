// Each registered name below is what the tool's own client code sends:
// Claude Code and VS Code through their CIMD documents, Codex through
// chatgpt.com/oauth/codex/client.json, OpenCode / Gemini CLI / Grok Build
// through their DCR request builders, Cursor through its documented
// registration. The older Claude Code appended the server name.

import { brandMcpClient } from '../client-brand';

describe('brandMcpClient', () => {
  it.each([
    ['Claude Code', 'claude-code', 'Claude Code'],
    ['Claude Code (liftoff)', 'claude-code', 'Claude Code'],
    ['Codex', 'codex', 'Codex'],
    ['OpenCode', 'opencode', 'OpenCode'],
    ['opencode', 'opencode', 'OpenCode'],
    ['Gemini CLI MCP Client', 'gemini-cli', 'Gemini CLI'],
    ['Grok', 'grok', 'Grok'],
    ['Visual Studio Code', 'vscode', 'VS Code'],
    ['Cursor', 'cursor', 'Cursor'],
    ['Windsurf', 'windsurf', 'Windsurf'],
  ])('%s → %s', (registered, slug, label) => {
    expect(brandMcpClient(registered)).toEqual({ slug, label });
  });

  it('keeps an unknown client under its own name with no slug', () => {
    expect(brandMcpClient('Muse personal agent')).toEqual({ slug: null, label: 'Muse personal agent' });
    expect(brandMcpClient('  spaced  ')).toEqual({ slug: null, label: 'spaced' });
  });

  it('does not read OpenCode as an OpenAI client', () => {
    expect(brandMcpClient('OpenCode').slug).toBe('opencode');
  });
});
