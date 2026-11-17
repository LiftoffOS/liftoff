// Which coding tool an OAuth client is, from the name it registered under.
//
// A client names itself: DCR posts `client_name`, CIMD publishes it in the
// metadata document. The names are stable per tool but not per person, and
// not uniform ("Gemini CLI MCP Client", "Claude Code (liftoff)" from an older
// Claude Code, "Visual Studio Code"), so the dashboard cannot compare them
// verbatim. This is the one place that turns a registered name into a slug
// the frontend keys its marks on and a label fit for a row or a header. An
// unknown client keeps its own name as the label and carries no slug, so it
// renders under a generic mark rather than a wrong one.
//
// Names come from the tools' own client source (Claude Code and VS Code via
// their CIMD documents, Codex via chatgpt.com/oauth/codex/client.json,
// OpenCode, Gemini CLI and Grok Build via their DCR request builders, Cursor
// via its documented registration).

export type McpClientSlug =
  | 'claude-code'
  | 'codex'
  | 'opencode'
  | 'gemini-cli'
  | 'grok'
  | 'vscode'
  | 'cursor'
  | 'windsurf';

export interface McpClientBrand {
  /** Stable key for the mark; null when the client is not a tool we know. */
  slug: McpClientSlug | null;
  /** The tool's product name, or the registered name when unknown. */
  label: string;
}

// First match wins. OpenCode is tested before the OpenAI family so its name
// cannot be read as an "open"-prefixed vendor by a later, looser pattern.
const KNOWN_CLIENTS: ReadonlyArray<{ slug: McpClientSlug; label: string; pattern: RegExp }> = [
  { slug: 'opencode', label: 'OpenCode', pattern: /opencode/ },
  { slug: 'claude-code', label: 'Claude Code', pattern: /claude/ },
  { slug: 'codex', label: 'Codex', pattern: /codex|openai/ },
  { slug: 'gemini-cli', label: 'Gemini CLI', pattern: /gemini/ },
  { slug: 'grok', label: 'Grok', pattern: /grok/ },
  { slug: 'vscode', label: 'VS Code', pattern: /visual studio code|vs code|vscode/ },
  { slug: 'cursor', label: 'Cursor', pattern: /cursor/ },
  { slug: 'windsurf', label: 'Windsurf', pattern: /windsurf/ },
];

export function brandMcpClient(clientName: string): McpClientBrand {
  const name = clientName.trim();
  const lower = name.toLowerCase();
  for (const known of KNOWN_CLIENTS) {
    if (known.pattern.test(lower)) return { slug: known.slug, label: known.label };
  }
  return { slug: null, label: name };
}
