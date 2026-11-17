// The labels file is pinned: every key and enumerated value the archive
// carries is the label the page shows, copied with a citation, and a change
// here is deliberate. A relabel on the page needs a matching change here.

import * as labels from '../labels';

describe('archive labels (pinned)', () => {
  it('names the files', () => {
    expect(labels.ARCHIVE_FILES).toEqual({
      readme: 'README.txt',
      manifest: 'workspace.json',
      conversations: 'conversations.json',
      teams: 'ai-teams.json',
      knowledge: 'knowledge.json',
      connections: 'connections.json',
      review: 'review.json',
      members: 'members.json',
      collaborators: 'external-collaborators.json',
      filesDir: 'files',
    });
    expect(labels.EXPORT_FORMAT_VERSION).toBe(1);
  });

  it('pins the manifest and section keys', () => {
    expect(labels.MANIFEST_KEYS).toEqual({
      formatVersion: 'Export format version', workspace: 'Workspace', exported: 'Exported', asOf: 'As of',
      exportedBy: 'Exported by', name: 'Name', email: 'Email', counts: 'Counts', note: 'Note',
    });
    expect(labels.AS_OF_NOTE).toBe(
      "Every record in this export was created at or before As of, and every decision recorded in it was made at or before As of; a team's description, a connection's status and a member's role are as they were when the export ran.",
    );
    // Product voice: no contractions and no em dashes.
    expect(labels.AS_OF_NOTE).not.toMatch(/\u2014/);
    expect(labels.AS_OF_NOTE).not.toMatch(/\b\w+n't\b|\b\w+'(re|ll|ve|d|m)\b/);
    expect(labels.SECTION_KEYS).toEqual({
      conversations: 'Conversations', messages: 'Messages', teams: 'Agents', knowledge: 'Knowledge',
      connected: 'Connected', approvals: 'Approvals', clarifications: 'Clarifications', members: 'Members',
      files: 'Files', invitations: 'Pending invitations', collaborators: 'External Agents',
    });
  });

  it('pins the conversation keys and the surface, channel and fallback words', () => {
    expect(labels.CONVERSATION_KEYS).toEqual({
      with: 'With', surface: 'Surface', channel: 'Channel', title: 'Title', startedBy: 'Started by',
      started: 'Started', lastMessage: 'Last message', messages: 'Messages', from: 'From',
      withHelpFrom: 'With help from', sent: 'Sent',
      message: 'Message', files: 'Files', attachments: 'Attachments', name: 'Name', path: 'Path', link: 'Link',
    });
    expect(labels.SURFACE_LABELS).toEqual({
      agent_chat: 'Agent', liftoff: 'Liftoff', caio: 'Chief AI Officer', insights: 'Insights Manager',
    });
    expect(labels.CHANNEL_LABELS).toEqual({ web: 'Web', slack: 'Slack', teams: 'Teams', mcp: 'MCP' });
    expect(labels.UNTITLED_CHAT).toBe('Untitled chat');
    expect(labels.WORKSPACE_MEMBER).toBe('Workspace member');
    expect(labels.UNKNOWN_AI_TEAM).toBe('Unknown agent');
  });

  it('pins the team card, the four questions in both of the builder\'s headings, and Learned Context', () => {
    expect(labels.TEAM_KEYS).toEqual({
      team: 'Team', status: 'Status', description: 'Description',
      responsibilities: 'What do you want them to do?',
      integrations: 'What should they work with?',
      integrationsWithCollaborators: 'Who and what should they work with?',
      guidance: 'Any additional guidance they should know?',
      learnedContext: 'Learned Context', context: 'Context', learned: 'Learned',
    });
    expect(labels.TEAM_STATUS_LABELS).toEqual({ active: 'Active', paused: 'Paused', draft: 'Awaiting Launch' });
  });

  it('pins the External Agent headings, pill, mode words and the rule sentences', () => {
    expect(labels.COLLABORATOR_KEYS).toEqual({
      name: 'Collaborator name', status: 'Status', description: 'Description',
      does: 'What does this collaborator do?',
      capabilities: 'Capabilities', capabilityName: 'Name', capabilityDescription: 'Description',
      worksWith: 'Who can this collaborator work with?',
      mode: 'How should they collaborate?',
      requestPermissions: 'Request Permissions', team: 'Team', rules: 'Rules',
    });
    expect(labels.COLLABORATOR_STATUS_LABELS).toEqual({
      connected: 'Active', pending: 'Awaiting Launch', pending_review: 'Awaiting Launch', disconnected: 'Paused', error: 'Error',
    });
    expect(labels.COLLABORATION_MODE_LABELS).toEqual({
      request_help: 'Request help', receive_delegated: 'Receive delegated work',
      two_way: 'Two-way collaboration', observe_only: 'Observe only',
    });
    expect(labels.REQUEST_TYPE_PHRASES).toEqual({
      read_summaries: 'read summaries', run_analysis: 'run analysis', draft_outputs: 'draft outputs', propose_updates: 'propose updates',
    });
    // TeamUpdatePage.tsx:178-185, the pill's three sentences; anything the page
    // has no words for is undefined, never a code.
    expect(labels.permissionSentence('allowed', 'read_summaries')).toBe('Can read summaries');
    expect(labels.permissionSentence('approval_required', 'run_analysis')).toBe('Needs approval to run analysis');
    expect(labels.permissionSentence('blocked', 'propose_updates')).toBe('Cannot propose updates');
    expect(labels.permissionSentence('allowed', 'delete_everything')).toBeUndefined();
    expect(labels.permissionSentence('maybe', 'read_summaries')).toBeUndefined();
  });

  it('pins the connection words', () => {
    expect(labels.CONNECTION_KEYS).toEqual({ app: 'App', status: 'Status', mcpEndpointUrl: 'MCP endpoint URL' });
    expect(labels.CONNECTION_STATUS_LABELS).toEqual({
      connected: 'Connected', needsReconnect: 'Needs Reconnect', awaitingApproval: 'Waiting for approval',
    });
  });

  it('pins the knowledge words and the two connector sets', () => {
    expect(labels.KNOWLEDGE_KEYS).toEqual({ title: 'Title', link: 'Link', source: 'Source', section: 'Section', added: 'Added' });
    expect(labels.KNOWLEDGE_SECTION_LABELS).toEqual({ help_center: 'Help Center', document: 'Documents' });
    expect([...labels.HELP_CENTER_CONNECTOR_TYPES]).toEqual(['zendesk', 'intercom']);
    expect([...labels.DOCUMENT_CONNECTOR_TYPES]).toEqual([
      'google_drive', 'microsoft_onedrive', 'microsoft_sharepoint', 'microsoft_onenote',
      'dropbox', 'box', 'atlassian_confluence', 'notion',
    ]);
  });

  it('pins the review words, the level and reason labels, and the status tables', () => {
    expect(labels.REVIEW_KEYS).toEqual({
      aiTeam: 'Agent', requested: 'Requested', level: 'Level', reason: 'Reason',
      requestedActions: 'Requested Actions', why: 'Why', details: 'Details', status: 'Status',
      decidedBy: 'Decided by', decided: 'Decided', rejectionReason: 'Rejection reason',
      feedbackAfterWindow: 'Feedback after the window', wouldHave: 'Would have', by: 'By', sent: 'Sent',
      asked: 'Asked', question: 'Question', answeredBy: 'Answered by', answered: 'Answered',
      declinedBy: 'Declined by', declined: 'Declined', app: 'App', action: 'Action',
      changedByApprover: 'Changed by the approver',
    });
    expect(labels.LEVEL_LABELS).toEqual({ 1: 'Standard', 2: 'Critical' });
    expect(labels.REASON_LABELS).toEqual({
      level_1_gate: 'Full review required',
      destructive_gate: 'High-impact change',
      super_destructive_gate: 'Critical change',
      sensitive_work: 'Sensitive action',
      communication_review: 'Review before sending',
      rate_limit_exceeded: 'Rate limit exceeded',
      merge_to_main: 'Merge to main branch',
      external_content_write: 'Acting on outside content',
      blast_radius: 'Large-scale change',
    });
    expect(labels.UNKNOWN_REASON).toBe('Needs review');
    expect(labels.APPROVAL_STATUS_LABELS).toEqual({
      approved: 'Approved', rejected: 'Rejected', withdrawn: 'Withdrawn', awaiting: 'Awaiting decision', passed: 'Passed',
    });
    expect(labels.CLARIFICATION_STATUS_LABELS).toEqual({
      answered: 'Answered', declined: 'Declined', passed: 'Passed', cancelled: 'Cancelled',
      failed: 'Failed', resolved: 'Resolved', awaiting: 'Awaiting answer',
    });
    expect(labels.WOULD_HAVE_LABELS).toEqual({ would_approve: 'Approved', would_reject: 'Rejected' });
  });

  it('pins the member words and the role labels', () => {
    expect(labels.MEMBER_KEYS).toEqual({
      name: 'Name', email: 'Email', role: 'Role', joined: 'Joined', worksWith: 'Works with', invited: 'Invited',
    });
    expect(labels.ROLE_LABELS).toEqual({ owner: 'Owner', admin: 'Admin', member: 'Member', viewer: 'Viewer' });
    expect(labels.HIDDEN).toBe('Hidden');
  });

  it('carries no internal name or enum code as a label', () => {
    const values: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === 'string') values.push(v);
      else if (v instanceof Set) return;
      else if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
    };
    walk(labels);
    // Every label is prose: it starts with a capital letter or is a file name,
    // and never snake_case or camelCase.
    for (const v of values) {
      expect(v).not.toMatch(/^[a-z]+_[a-z_]+$/);
      expect(v).not.toMatch(/^[a-z]+[A-Z]/);
    }
  });
});
