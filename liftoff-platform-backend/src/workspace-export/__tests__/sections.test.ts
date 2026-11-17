// ai-teams.json, external-collaborators.json, knowledge.json, connections.json, members.json.

jest.mock('../../connectors/connector-service-client', () => ({
  getCatalog: jest.fn(),
  listConnectorsForTenant: jest.fn(),
}));
jest.mock('../../internal-agents/integration-enrichment', () => ({
  enrichIntegrationsWithType: jest.fn(async (_t: string, i: unknown[]) => i),
}));

import { getCatalog, listConnectorsForTenant } from '../../connectors/connector-service-client';
import { enrichIntegrationsWithType } from '../../internal-agents/integration-enrichment';
import {
  collectConnectors,
  catalogDisplayNames,
  resolveTeamIntegrationNames,
  projectTeams,
  projectCollaborators,
  projectKnowledge,
  projectConnections,
  projectMembers,
  projectInvitations,
} from '../sections';
import type { ConnectorCatalogResponse } from '@liftoffos/connector-types';
import type { CustomMcpRow, TeamRow, MemberRow, AssignmentRow, ExternalCollaboratorRow } from '../queries';

type IntegrationPermissionLike = { id: string; type?: string; selectedObjects: string[] };

const AS_OF = new Date('2026-09-18T21:04:11.318Z');
const CATALOG = {
  connectors: [
    { type: 'github', displayName: 'GitHub' },
    { type: 'slack', displayName: 'Slack' },
    { type: 'google_drive', displayName: 'Google Drive' },
    { type: 'zendesk', displayName: 'Zendesk' },
    { type: 'custom_mcp_server', displayName: 'Custom MCP Server' },
  ],
  version: 'v', categoryLabels: {},
} as unknown as ConnectorCatalogResponse;
const names = catalogDisplayNames(CATALOG);
const CUSTOM: CustomMcpRow = {
  id: 'c-mcp', sort_cursor: 'x', connector_id: 'c-mcp', name: 'Internal Docs',
  endpoint_url: 'https://mcp.example.com/sse', created_at: new Date('2026-09-01T00:00:00Z'),
};
const customById = new Map([[CUSTOM.connector_id, CUSTOM]]);

beforeEach(() => {
  jest.clearAllMocks();
});

describe('collectConnectors', () => {
  it('accepts a stale cached catalog and names connectors as the 503 when there is none at all', async () => {
    (getCatalog as jest.Mock).mockResolvedValueOnce(CATALOG);
    (listConnectorsForTenant as jest.Mock).mockResolvedValueOnce([]);
    await expect(collectConnectors('t', 'acc')).resolves.toEqual({ connectors: [], catalog: CATALOG });

    (getCatalog as jest.Mock).mockRejectedValueOnce(new Error('connector catalog fetch failed: 503'));
    await expect(collectConnectors('t', 'acc')).rejects.toMatchObject({ name: 'ExportSourceUnavailableError', source: 'connectors' });

    (getCatalog as jest.Mock).mockResolvedValueOnce(CATALOG);
    (listConnectorsForTenant as jest.Mock).mockRejectedValueOnce(new Error('listConnectorsForTenant failed: 502'));
    await expect(collectConnectors('t', 'acc')).rejects.toMatchObject({ source: 'connectors' });
  });
});

describe('projectConnections', () => {
  const row = (o: Record<string, unknown>) => ({ id: 'c-1', type: 'github', status: 'active', installState: null, createdAt: '2026-09-01T00:00:00.000Z', ...o });

  it('renders the three states the page renders and nothing else', () => {
    expect(projectConnections([
      row({ id: 'c-1', type: 'github', status: 'active' }),
      row({ id: 'c-2', type: 'slack', status: 'error' }),
      row({ id: 'c-3', type: 'github', status: 'pending', installState: 'awaiting_org_approval' }),
      row({ id: 'c-4', type: 'github', status: 'pending', installState: null }),
      row({ id: 'c-5', type: 'github', status: 'disconnected' }),
    ], names, customById, AS_OF)).toEqual([
      { App: 'GitHub', Status: 'Connected' },
      { App: 'Slack', Status: 'Needs Reconnect' },
      { App: 'GitHub', Status: 'Waiting for approval' },
    ]);
  });

  it('omits a type the catalog does not carry, never using the row\'s own name', () => {
    expect(projectConnections([row({ type: 'workday', name: 'Workday (730793)' })], names, customById, AS_OF)).toEqual([]);
  });

  it('sorts by created time ascending then id, whatever order the service listed them in', () => {
    expect(projectConnections([
      row({ id: 'c-b', type: 'slack', createdAt: '2026-09-02T00:00:00.000Z' }),
      row({ id: 'c-a', type: 'github', createdAt: '2026-09-01T00:00:00.000Z' }),
      row({ id: 'c-c', type: 'github', createdAt: '2026-09-02T00:00:00.000Z' }),
    ], names, customById, AS_OF).map((e) => e.App)).toEqual(['GitHub', 'Slack', 'GitHub']);
  });

  it('excludes a connector created after asOf', () => {
    expect(projectConnections([row({ createdAt: '2026-09-18T22:00:00.000Z' })], names, customById, AS_OF)).toEqual([]);
    expect(projectConnections([row({ createdAt: null })], names, customById, AS_OF)).toHaveLength(1);
  });

  it('folds a custom MCP server into the list by connector id with its own name and endpoint, never twice', () => {
    expect(projectConnections([
      row({ id: 'c-mcp', type: 'custom_mcp_server', name: 'Internal Docs (77)', createdAt: '2026-08-15T00:00:00.000Z' }),
      row({ id: 'c-1', createdAt: '2026-08-01T00:00:00.000Z' }),
    ], names, customById, AS_OF)).toEqual([
      { App: 'GitHub', Status: 'Connected' },
      { App: 'Internal Docs', Status: 'Connected', 'MCP endpoint URL': 'https://mcp.example.com/sse' },
    ]);
  });
});

describe('teams', () => {
  const team = (o: Partial<TeamRow>): TeamRow => ({
    id: 'team-1', sort_cursor: 'x', role: 'Code Reviewer', summary: 'Reviews pull requests.',
    responsibilities: 'Review every PR for correctness and style.', additional_context: 'Never merge.',
    integrations: [], status: 'paused', created_at: new Date('2026-09-01T00:00:00Z'), ...o,
  });

  const apps = (list: string[]) => new Map([['team-1', { names: list, withCollaborators: false }]]);
  const none = new Map();
  const TEAM_NAMES = new Map([['team-1', 'Code Reviewer'], ['agent-9', 'Release Coordinator']]);
  const COLLABORATOR_NAMES = new Map([['ext-1', 'Legal Bot']]);

  it('writes the card, the four questions with the pill\'s words, and an empty Learned Context', () => {
    expect(projectTeams([team({})], apps(['GitHub', 'Slack']), none)).toEqual([{
      Team: 'Code Reviewer',
      Status: 'Paused',
      Description: 'Reviews pull requests.',
      'What do you want them to do?': 'Review every PR for correctness and style.',
      'What should they work with?': ['GitHub', 'Slack'],
      'Any additional guidance they should know?': 'Never merge.',
      'Learned Context': [],
    }]);
    expect(projectTeams([team({ status: 'draft' })], new Map(), none)[0].Status).toBe('Awaiting Launch');
    expect(projectTeams([team({ status: 'active' })], new Map(), none)[0].Status).toBe('Active');
  });

  it('falls the description through to the responsibilities when the summary is empty, as the card does', () => {
    expect(projectTeams([team({ summary: '' })], new Map(), none)[0].Description).toBe('Review every PR for correctness and style.');
    const bare = projectTeams([team({ summary: null, responsibilities: null, additional_context: null })], new Map(), none)[0];
    expect(bare).not.toHaveProperty('Description');
    expect(bare).not.toHaveProperty('Any additional guidance they should know?');
    expect(bare['What should they work with?']).toEqual([]);
    expect(bare).not.toHaveProperty('Who and what should they work with?');
  });

  it('uses the builder\'s other heading when the list holds an agent or an External Agent', () => {
    const withCollaborators = new Map([['team-1', { names: ['Release Coordinator', 'GitHub'], withCollaborators: true }]]);
    const entry = projectTeams([team({})], withCollaborators, none)[0];
    expect(entry['Who and what should they work with?']).toEqual(['Release Coordinator', 'GitHub']);
    expect(entry).not.toHaveProperty('What should they work with?');
  });

  it('writes Learned Context as the page shows it: the normalised text and when it was learned, oldest first', () => {
    const learned = new Map([['team-1', [
      { id: 'm-2', content: '**Rule:** Use mcp__github-eaec0c30__get_pr for PRs\n**Why:** it works', createdAt: '2026-09-10T10:00:00.000Z' },
      { id: 'm-1', content: 'Prefers   short replies.', createdAt: '2026-09-09T10:00:00.000Z' },
    ]]]);
    expect(projectTeams([team({})], apps([]), learned)[0]['Learned Context']).toEqual([
      { Context: 'Prefers short replies.', Learned: '2026-09-09T10:00:00.000Z' },
      { Context: 'Rule: Use get_pr for PRs · Why: it works', Learned: '2026-09-10T10:00:00.000Z' },
    ]);
  });

  it('names who and what a team works with, in binding order: apps by catalog name, the custom server by its own, teams and collaborators by theirs', async () => {
    (enrichIntegrationsWithType as jest.Mock).mockImplementationOnce(async () => [
      { id: 'c-1', type: 'github', selectedObjects: [] },
      { id: 'agent-9', type: 'internal_agent', selectedObjects: [] },
      { id: 'c-mcp', type: 'custom_mcp_server', selectedObjects: [] },
      { id: 'ext-1', type: 'external_agent', selectedObjects: [] },
      { id: 'ext-gone', type: 'external_agent', selectedObjects: [] },
      { id: 'c-x', type: 'unknown_vendor', selectedObjects: [] },
    ]);
    const out = await resolveTeamIntegrationNames('t', [team({ integrations: [{ id: 'c-1' }] })], names, customById, TEAM_NAMES, COLLABORATOR_NAMES);
    expect(out.get('team-1')).toEqual({
      names: ['GitHub', 'Release Coordinator', 'Internal Docs', 'Legal Bot'],
      withCollaborators: true,
    });
  });

  it('reports no collaborators for a team bound to apps alone', async () => {
    (enrichIntegrationsWithType as jest.Mock).mockImplementationOnce(async () => [
      { id: 'c-1', type: 'github', selectedObjects: [] },
    ]);
    const out = await resolveTeamIntegrationNames('t', [team({ integrations: [{ id: 'c-1' }] })], names, customById, TEAM_NAMES, COLLABORATOR_NAMES);
    expect(out.get('team-1')).toEqual({ names: ['GitHub'], withCollaborators: false });
  });

  it('leaves an orphaned binding out rather than refusing the export, and keeps the rest', async () => {
    // The helper throws for the whole list when any binding resolves to
    // nothing; the export then resolves each on its own and omits the orphan.
    const orphan = new Error('Integration permission has no resolvable type: id=c-gone (tenant=t). Either the row is orphaned');
    (enrichIntegrationsWithType as jest.Mock)
      .mockRejectedValueOnce(orphan)
      .mockImplementationOnce(async (_t: string, i: IntegrationPermissionLike[]) => [{ ...i[0], type: 'github' }])
      .mockRejectedValueOnce(orphan)
      .mockImplementationOnce(async (_t: string, i: IntegrationPermissionLike[]) => [{ ...i[0], type: 'slack' }]);
    const out = await resolveTeamIntegrationNames('t', [team({ integrations: [{ id: 'c-1' }, { id: 'c-gone' }, { id: 'c-2' }] })], names, customById, TEAM_NAMES, COLLABORATOR_NAMES);
    expect(out.get('team-1')?.names).toEqual(['GitHub', 'Slack']);
    expect(enrichIntegrationsWithType).toHaveBeenCalledTimes(4);
  });

  it('names connectors as the 503 when enrichment cannot reach connector-service', async () => {
    (enrichIntegrationsWithType as jest.Mock).mockRejectedValueOnce(new Error('resolve failed'));
    await expect(resolveTeamIntegrationNames('t', [team({ integrations: [{ id: 'c-1' }] })], names, customById, TEAM_NAMES, COLLABORATOR_NAMES))
      .rejects.toMatchObject({ source: 'connectors' });
  });
});

describe('external agents', () => {
  const TEAM_NAMES = new Map([['team-1', 'Code Reviewer'], ['team-2', 'Release Coordinator']]);
  const collaborator = (o: Partial<ExternalCollaboratorRow>): ExternalCollaboratorRow => ({
    id: 'ext-1', sort_cursor: 'x', name: 'Legal Bot', description: 'Reviews contracts.', summary: 'A contract reviewer.',
    status: 'connected', collaboration_mode: 'two_way',
    detected_capabilities: [
      { id: 'cap-1', name: 'Review contract', description: 'Reads a contract and flags risk.', rawToolName: 'mcp__legal__review_contract' },
      { id: 'cap-2', name: 'Summarise', description: '', rawToolName: 'mcp__legal__summarise' },
      { id: 'cap-3', name: '', description: 'nameless', rawToolName: 'x' },
    ],
    allowed_internal_agent_ids: ['team-1', 'team-gone', 'team-2', 'team-1'],
    request_rules: [
      { internalAgentId: 'team-1', internalAgentName: 'Old Name', permissions: {
        read_summaries: 'allowed', run_analysis: 'approval_required', draft_outputs: 'blocked', propose_updates: 'allowed' } },
      { internalAgentId: 'team-gone', internalAgentName: 'Retired Team', permissions: { read_summaries: 'allowed', propose_updates: 'maybe', bogus: 'allowed' } },
      { internalAgentId: 'team-none', permissions: { read_summaries: 'allowed' } },
    ],
    created_at: new Date('2026-09-01T00:00:00Z'), ...o,
  });

  it('writes the Update Team page\'s headings and the pill\'s words, the rules as the sentences their pills read as, and never an id or a tool name', () => {
    expect(projectCollaborators([collaborator({})], TEAM_NAMES)).toEqual([{
      'Collaborator name': 'Legal Bot',
      Status: 'Active',
      Description: 'Reviews contracts.',
      'What does this collaborator do?': 'Reviews contracts.',
      Capabilities: [
        { Name: 'Review contract', Description: 'Reads a contract and flags risk.' },
        { Name: 'Summarise' },
      ],
      'Who can this collaborator work with?': ['Code Reviewer', 'Release Coordinator'],
      'How should they collaborate?': 'Two-way collaboration',
      'Request Permissions': [
        { Team: 'Code Reviewer', Rules: ['Can read summaries', 'Needs approval to run analysis', 'Cannot draft outputs', 'Can propose updates'] },
        { Team: 'Retired Team', Rules: ['Can read summaries'] },
      ],
    }]);
    const blob = JSON.stringify(projectCollaborators([collaborator({})], TEAM_NAMES));
    for (const forbidden of ['cap-1', 'mcp__legal', 'team-1', 'team-gone', 'ext-1', 'bogus', 'maybe']) {
      expect({ forbidden, present: blob.includes(forbidden) }).toEqual({ forbidden, present: false });
    }
  });

  it('falls the description through to the summary as the card does, and omits what is empty', () => {
    const bare = projectCollaborators([collaborator({
      description: '', summary: 'A contract reviewer.', status: 'pending_review', collaboration_mode: 'observe_only',
      detected_capabilities: null, allowed_internal_agent_ids: null, request_rules: 'not-a-list',
    })], TEAM_NAMES)[0];
    expect(bare).toEqual({
      'Collaborator name': 'Legal Bot',
      Status: 'Awaiting Launch',
      Description: 'A contract reviewer.',
      Capabilities: [],
      'Who can this collaborator work with?': [],
      'How should they collaborate?': 'Observe only',
      'Request Permissions': [],
    });
    expect(bare).not.toHaveProperty('What does this collaborator do?');
    const unknown = projectCollaborators([collaborator({ status: 'weird', collaboration_mode: 'weird' })], TEAM_NAMES)[0];
    expect(unknown).not.toHaveProperty('Status');
    expect(unknown).not.toHaveProperty('How should they collaborate?');
  });

  it('writes every pill word', () => {
    const statuses = ['connected', 'pending', 'pending_review', 'disconnected', 'error'].map(
      (status) => projectCollaborators([collaborator({ status })], TEAM_NAMES)[0].Status);
    expect(statuses).toEqual(['Active', 'Awaiting Launch', 'Awaiting Launch', 'Paused', 'Error']);
  });
});

describe('knowledge', () => {
  it('writes title, link, source and section by the page\'s two sets', () => {
    const at = new Date('2026-09-01T10:14:00Z');
    expect(projectKnowledge([
      { id: 'k1', sort_cursor: 'x', title: 'Refund policy', source_url: 'https://docs.google.com/document/d/1', connector_type: 'google_drive', connector_id: 'c-9', created_at: at },
      { id: 'k2', sort_cursor: 'x', title: 'FAQ', source_url: null, connector_type: 'zendesk', connector_id: 'c-8', created_at: at },
      { id: 'k3', sort_cursor: 'x', title: 'Pasted', source_url: null, connector_type: null, connector_id: null, created_at: at },
      { id: 'k4', sort_cursor: 'x', title: 'Other', source_url: null, connector_type: 'github', connector_id: 'c-1', created_at: at },
    ], names)).toEqual([
      { Title: 'Refund policy', Link: 'https://docs.google.com/document/d/1', Source: 'Google Drive', Section: 'Documents', Added: '2026-09-01T10:14:00.000Z' },
      { Title: 'FAQ', Source: 'Zendesk', Section: 'Help Center', Added: '2026-09-01T10:14:00.000Z' },
      { Title: 'Pasted', Added: '2026-09-01T10:14:00.000Z' },
      { Title: 'Other', Source: 'GitHub', Added: '2026-09-01T10:14:00.000Z' },
    ]);
  });
});

describe('members', () => {
  const member = (o: Partial<MemberRow>): MemberRow => ({
    id: 'm1', sort_cursor: 'x', account_id: 'acc-1', role: 'owner', joined_at: new Date('2026-03-02T18:20:00Z'),
    created_at: new Date('2026-03-02T18:20:00Z'), first_name: 'Alex', last_name: 'Rivera', email: 'person@example.com', ...o,
  });
  const assignment = (o: Partial<AssignmentRow>): AssignmentRow => ({
    id: 'a1', sort_cursor: 'x', account_id: 'acc-1', agent_id: 'team-1', agent_name: 'Code Reviewer',
    created_at: new Date('2026-04-01T00:00:00Z'), ...o,
  });

  it('writes name, email, the capitalised role, joined, and the teams the person works with', () => {
    expect(projectMembers([member({})], [assignment({}), assignment({ id: 'a2', agent_name: 'Claude Coder' })])).toEqual([{
      Name: 'Alex Rivera', Email: 'person@example.com', Role: 'Owner', Joined: '2026-03-02T18:20:00.000Z',
      'Works with': ['Code Reviewer', 'Claude Coder'],
    }]);
  });

  it('omits Works with for a person with no assignments, and Name for one with no name', () => {
    const out = projectMembers([member({ account_id: 'acc-2', first_name: null, last_name: null, role: 'viewer' })], [assignment({})]);
    expect(out).toEqual([{ Email: 'person@example.com', Role: 'Viewer', Joined: '2026-03-02T18:20:00.000Z' }]);
  });

  it('writes pending invitations', () => {
    expect(projectInvitations([{ id: 'i1', sort_cursor: 'x', email: 'colleague@example.com', role: 'member', created_at: new Date('2026-09-10T09:00:00Z') }]))
      .toEqual([{ Email: 'colleague@example.com', Role: 'Member', Invited: '2026-09-10T09:00:00.000Z' }]);
  });
});
