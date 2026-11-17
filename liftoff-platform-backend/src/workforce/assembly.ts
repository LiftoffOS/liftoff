import type { InternalAgent } from '../internal-agents/types';
import type { ExternalAgent } from '../external-agents/types';
import type { PersonWithAssignments } from '../person-assignments/types';
import type { DeveloperProxyCredential } from '../claude-code-proxy/developer-proxy-client';
import type { OauthConnectedTool } from '../oauth/connected-tools';
import type { ConnectionProfile } from './connection-profiles';

export interface McpTokenRow {
  id: string;
  tenantId: string;
  accountId: string;
  name: string;
  status: string;
  tokenPrefix: string;
  lastUsedAt: string | null;
  expiresAt: string;
  createdAt: string;
}

export interface WorkforceClaudeCodeKey {
  id: string;
  tenantId: string;
  accountId: string;
  keyPrefix: string;
  keyHint: string;
  name: string;
  description: string | null;
  planType: string | null;
  costPerMonth: number | null;
  status: 'active' | 'revoked';
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
  keyType: 'developer_proxy' | 'mcp';
  /** What the frontend keys the row's mark on. Developer-proxy rows carry the
   *  credential vendor ('anthropic' | 'openai'); OAuth-connected tools carry
   *  the client slug from `brandMcpClient` ('codex', 'gemini-cli', ...) or
   *  'mcp' when the client is not one we know; static collab tokens report
   *  'claude_code_mcp', the shape the frontend's own MCP-token mapper
   *  produces. */
  vendor: string;
  /** OAuth-connected tools only: the name the client registered under, and
   *  the label the row is named with. Absent on credential rows. */
  clientName?: string;
  clientLabel?: string;
}

export interface WorkforceStats {
  // Weighted hours-saved estimate over the trailing 30 days; computed
  // server-side (workforce/hours-saved.ts) for the dashboard metric tiles.
  hoursSavedLast30Days: number;
}

export interface WorkforceResponse {
  internalAgents: InternalAgent[];
  externalAgents: ExternalAgent[];
  claudeCodeKeys: WorkforceClaudeCodeKey[];
  personnel: PersonWithAssignments[];
  stats: WorkforceStats;
}

interface AgentActivityEntry {
  timestamp: string;
  action: string;
}

/** Pure assembly — no I/O. Takes raw data from 6 sources, merges and returns the response.
 *  Developer proxy credentials are fetched server-side via OIDC (developer-proxy-client) and
 *  included alongside MCP tokens so the frontend needs only one endpoint. */
export function assembleWorkforce(
  internalAgents: InternalAgent[],
  externalAgents: ExternalAgent[],
  mcpTokens: McpTokenRow[],
  personnel: PersonWithAssignments[],
  activityMap: Record<string, AgentActivityEntry>,
  devProxyCredentials: DeveloperProxyCredential[] = [],
  stats: WorkforceStats = { hoursSavedLast30Days: 0 },
  oauthTools: OauthConnectedTool[] = [],
  profiles: Map<string, ConnectionProfile> = new Map(),
): WorkforceResponse {
  for (const agent of internalAgents) {
    const entry = activityMap[agent.id] ?? null;
    agent.lastActivity = entry?.timestamp ?? null;
    agent.lastActivityAction = entry?.action ?? null;
  }
  for (const agent of externalAgents) {
    const entry = activityMap[agent.id] ?? null;
    agent.lastActivity = entry?.timestamp ?? null;
    agent.lastActivityAction = entry?.action ?? null;
  }

  // Coding-tool rows carry no stored description: neither a proxy credential
  // nor an MCP token has a description column, so the field was always null and
  // the teams table showed an em dash where every other row says what it is.
  // What is worth saying about one of these is whose tool it is, so the
  // description is derived here. The owner is named by the same heuristic the
  // dashboard's Workspace Members tooltips use: first name, or the email when
  // there is no first name to show.
  //
  // `personnel` is already assembled for this response, so the lookup costs a
  // map rather than a query. An account missing from it (a key whose owner has
  // since left the workspace) falls back to the unattributed form rather than
  // naming nobody.
  const personByAccountId = new Map(personnel.map(p => [p.accountId, p]));
  const codingToolDescription = (accountId: string): string => {
    const person = personByAccountId.get(accountId);
    const owner = person ? person.firstName?.trim() || person.email : null;
    return owner ? `AI Coding Tool for ${owner}` : 'AI Coding Tool';
  };

  // An OAuth-connected tool is named the way the Switch connectors name a
  // credential row, "Person (Tool)", composed here rather than stored: the
  // anchor keeps the registered client name verbatim for audit, and the
  // person's name follows their account. Full name, else the email, the same
  // rule the connectors apply when they label a credential.
  const connectedToolName = (tool: OauthConnectedTool): string => {
    const person = personByAccountId.get(tool.accountId);
    const fullName = person ? `${person.firstName ?? ''} ${person.lastName ?? ''}`.trim() : '';
    const owner = fullName || person?.email || null;
    return owner ? `${owner} (${tool.clientLabel})` : tool.clientLabel;
  };

  // Archived (revoked) connections are hidden from the teams view — revoking a
  // proxy credential or MCP token is the "Archive" action, so it must remove the
  // row, not just flip its badge. The rows are retained server-side for audit.
  const claudeCodeKeys: WorkforceClaudeCodeKey[] = [
    ...devProxyCredentials.filter(c => c.status !== 'revoked').map(c => ({
      id: c.id,
      tenantId: c.tenantId,
      accountId: c.userId,
      keyPrefix: c.keyPrefix,
      keyHint: c.keyHint,
      name: c.label,
      description: codingToolDescription(c.userId),
      planType: null,
      costPerMonth: null,
      status: c.status as 'active' | 'revoked',
      lastUsedAt: c.lastUsedAt,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      keyType: 'developer_proxy' as const,
      // Older credential rows predate the vendor column; they are Anthropic by
      // definition, since OpenAI support shipped after it.
      vendor: c.vendor ?? 'anthropic',
    })),
    ...mcpTokens.filter(t => t.status !== 'revoked').map(t => ({
      id: t.id,
      tenantId: t.tenantId,
      accountId: t.accountId,
      keyPrefix: t.tokenPrefix,
      keyHint: '',
      name: t.name,
      description: codingToolDescription(t.accountId),
      planType: null,
      costPerMonth: null,
      status: t.status as 'active' | 'revoked',
      lastUsedAt: t.lastUsedAt,
      createdAt: t.createdAt,
      updatedAt: t.createdAt,
      keyType: 'mcp' as const,
      vendor: 'claude_code_mcp',
    })),
    ...oauthTools.map(t => ({
      id: t.id,
      tenantId: t.tenantId,
      accountId: t.accountId,
      keyPrefix: '',
      keyHint: '',
      name: connectedToolName(t),
      description: codingToolDescription(t.accountId),
      planType: null,
      costPerMonth: null,
      status: 'active' as const,
      lastUsedAt: t.lastUsedAt,
      createdAt: t.createdAt,
      updatedAt: t.createdAt,
      keyType: 'mcp' as const,
      vendor: t.clientSlug ?? 'mcp',
      clientName: t.clientName,
      clientLabel: t.clientLabel,
    })),
  ].map(row => {
    // What the person wrote on the update page wins over what is derived;
    // a NULL profile column means they never touched that field.
    const profile = profiles.get(row.id);
    if (!profile) return row;
    return {
      ...row,
      name: profile.name ?? row.name,
      description: profile.description ?? row.description,
    };
  });

  return { internalAgents, externalAgents, claudeCodeKeys, personnel, stats };
}
