// Every key and enumerated value the archive carries, and where each was
// copied from.
//
// The rule: a JSON key or enum value is the label the page shows for it, and
// internal names and enum codes never appear. Where the page shows a value
// unlabelled, the key is the noun of the page's heading or form. Each label
// below names the React file and line it was copied from, and the whole file
// is pinned by a test so a change here is deliberate. A relabel on the page
// needs a matching change here: this service cannot import React's constants
// (they are private to the page), and a shared package is not warranted for
// thirty strings. The words marked "plan copy" have no page precedent and are
// the export's own.

// ── Files in the archive ────────────────────────────────────────────────

export const ARCHIVE_FILES = {
  readme: 'README.txt',
  manifest: 'workspace.json',
  conversations: 'conversations.json',
  teams: 'ai-teams.json',
  knowledge: 'knowledge.json',
  connections: 'connections.json',
  review: 'review.json',
  members: 'members.json',
  collaborators: 'external-collaborators.json',
  /** The folder every produced file sits under. */
  filesDir: 'files',
} as const;

export const EXPORT_FORMAT_VERSION = 1;

// ── workspace.json ──────────────────────────────────────────────────────

export const MANIFEST_KEYS = {
  formatVersion: 'Export format version',
  workspace: 'Workspace',
  exported: 'Exported',
  asOf: 'As of',
  exportedBy: 'Exported by',
  name: 'Name',
  email: 'Email',
  counts: 'Counts',
  /** Plan copy: the one sentence saying what `As of` is and is not. */
  note: 'Note',
} as const;

/** What `As of` means, in the manifest's own words (plan copy): the inclusion
 *  boundary for records and recorded decisions, not a reconstruction of
 *  mutable properties. */
export const AS_OF_NOTE =
  'Every record in this export was created at or before As of, and every decision recorded in it was made at or before As of; a team\'s description, a connection\'s status and a member\'s role are as they were when the export ran.';

/** The top-level array of each file, and the manifest's count keys. */
export const SECTION_KEYS = {
  conversations: 'Conversations',
  messages: 'Messages',
  teams: 'Agents',
  knowledge: 'Knowledge',
  connected: 'Connected',
  approvals: 'Approvals',
  clarifications: 'Clarifications',
  members: 'Members',
  /** How many files sit under files/ as bytes; a connector-native document
   *  is a link in the transcript and is not counted here. */
  files: 'Files',
  invitations: 'Pending invitations',
  /** The Teams page's own word for them (TeamsPage.tsx:1478, the section heading). */
  collaborators: 'External Agents',
} as const;

// ── conversations.json ──────────────────────────────────────────────────

export const CONVERSATION_KEYS = {
  with: 'With',
  surface: 'Surface',
  channel: 'Channel',
  title: 'Title',
  startedBy: 'Started by',
  started: 'Started',
  lastMessage: 'Last message',
  messages: 'Messages',
  from: 'From',
  /** Colleagues who had a hand in a reply without writing it: the teammates
   *  an agent delegated part of the answer to. Absent on a reply the author
   *  wrote alone; the author is always `From`. */
  withHelpFrom: 'With help from',
  sent: 'Sent',
  message: 'Message',
  files: 'Files',
  attachments: 'Attachments',
  name: 'Name',
  path: 'Path',
  link: 'Link',
} as const;

/** The four surfaces, by the name each page gives itself. */
export const SURFACE_LABELS = {
  agent_chat: 'Agent',
  liftoff: 'Liftoff',
  caio: 'Chief AI Officer',
  insights: 'Insights Manager',
} as const;

/** Team chat only; the channel column's four values. */
export const CHANNEL_LABELS: Record<string, string> = {
  web: 'Web',
  slack: 'Slack',
  teams: 'Teams',
  mcp: 'MCP',
};

/** src/components/Chat/ChatHistoryModal.tsx:166 (`thread.title ?? 'Untitled chat'`). */
export const UNTITLED_CHAT = 'Untitled chat';

/** A human message with no recorded sender (plan copy, DECISION 1): says what
 *  is known, a member of this workspace wrote it, rather than asserting
 *  ignorance. */
export const WORKSPACE_MEMBER = 'Workspace member';

// ── ai-teams.json ───────────────────────────────────────────────────────

export const TEAM_KEYS = {
  /** Plan copy: the card's name is unlabelled (TeamsPage.tsx:240). */
  team: 'Team',
  /** The pill (TeamsPage.tsx:268). */
  status: 'Status',
  /** Plan copy: the card's description is unlabelled (TeamsPage.tsx:242-244). */
  description: 'Description',
  /** src/components/ResponsibilitiesInput.tsx:51. */
  responsibilities: 'What do you want them to do?',
  /** src/components/IntegrationsSelector.tsx:113 (the variant with no collaborators). */
  integrations: 'What should they work with?',
  /** src/components/IntegrationsSelector.tsx:112: the heading the builder picks
   *  when the list holds any agent or External Agent. */
  integrationsWithCollaborators: 'Who and what should they work with?',
  /** src/components/AdditionalGuidanceInput.tsx:51. */
  guidance: 'Any additional guidance they should know?',
  /** src/pages/Dashboard/TeamUpdatePage.tsx:1152, the collapsible's heading. */
  learnedContext: 'Learned Context',
  /** Plan copy: each Learned Context row shows its text and its date unlabelled
   *  (TeamUpdatePage.tsx:1177-1182). */
  context: 'Context',
  learned: 'Learned',
} as const;

/** TeamsPage.tsx:268: `status === 'active' ? 'Active' : status === 'paused' ? 'Paused' : 'Awaiting Launch'`. */
export const TEAM_STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  paused: 'Paused',
  draft: 'Awaiting Launch',
};

// ── external-collaborators.json ─────────────────────────────────────────
//
// The Update Team page's External Agent branch is the source for every
// heading (src/pages/Dashboard/TeamUpdatePage.tsx, the `isExternal` render at
// :1520-1660), the Teams card for the pill and the description, and
// src/services/externalAgents.ts for the collaboration-mode words.

export const COLLABORATOR_KEYS = {
  /** TeamUpdatePage.tsx:1525 ("Collaborator name *", the asterisk marks the
   *  field as required) and TeamConnector/steps/IdentifyAgentStep.tsx:58. */
  name: 'Collaborator name',
  /** The pill (TeamsPage.tsx:257-262). */
  status: 'Status',
  /** Plan copy: the card's description is unlabelled (TeamsPage.tsx:242-244). */
  description: 'Description',
  /** TeamUpdatePage.tsx:1536 and IdentifyAgentStep.tsx:193. */
  does: 'What does this collaborator do?',
  /** TeamUpdatePage.tsx:1547. Each row shows a capability's name and its
   *  description, unlabelled (:1560-1561); the two keys below are plan copy. */
  capabilities: 'Capabilities',
  capabilityName: 'Name',
  capabilityDescription: 'Description',
  /** TeamUpdatePage.tsx:1588. */
  worksWith: 'Who can this collaborator work with?',
  /** TeamUpdatePage.tsx:1613. */
  mode: 'How should they collaborate?',
  /** TeamUpdatePage.tsx:1639. One card per agent, named by the team
   *  (:1643), four pills each; `team` and `rules` are plan copy. */
  requestPermissions: 'Request Permissions',
  team: 'Team',
  rules: 'Rules',
} as const;

/** TeamsPage.tsx:257-262, the pill for an External Agent. */
export const COLLABORATOR_STATUS_LABELS: Record<string, string> = {
  connected: 'Active',
  pending: 'Awaiting Launch',
  pending_review: 'Awaiting Launch',
  disconnected: 'Paused',
  error: 'Error',
};

/** src/services/externalAgents.ts:44-61 (`COLLABORATION_MODE_LABELS[mode].title`),
 *  the word the mode selector shows (TeamUpdatePage.tsx:1629). */
export const COLLABORATION_MODE_LABELS: Record<string, string> = {
  request_help: 'Request help',
  receive_delegated: 'Receive delegated work',
  two_way: 'Two-way collaboration',
  observe_only: 'Observe only',
};

/** TeamUpdatePage.tsx:169-174 (`typeLabels` inside `getPermissionLabel`). */
export const REQUEST_TYPE_PHRASES: Record<string, string> = {
  read_summaries: 'read summaries',
  run_analysis: 'run analysis',
  draft_outputs: 'draft outputs',
  propose_updates: 'propose updates',
};

/** TeamUpdatePage.tsx:178-185 (`getPermissionLabel`): the sentence each pill
 *  reads as. Undefined for a permission or a type the page has no words for. */
export function permissionSentence(permission: string, requestType: string): string | undefined {
  const action = REQUEST_TYPE_PHRASES[requestType];
  if (action === undefined) return undefined;
  switch (permission) {
    case 'allowed': return `Can ${action}`;
    case 'approval_required': return `Needs approval to ${action}`;
    case 'blocked': return `Cannot ${action}`;
    default: return undefined;
  }
}

// ── connections.json ────────────────────────────────────────────────────

export const CONNECTION_KEYS = {
  /** Plan copy: the card's title is unlabelled (useIntegrations.ts:90-96). */
  app: 'App',
  status: 'Status',
  /** src/components/McpEndpointFields.tsx:69 (`urlLabel = 'MCP endpoint URL'`). */
  mcpEndpointUrl: 'MCP endpoint URL',
} as const;

/** src/pages/Dashboard/ConnectionsPage.tsx:226-241, the three states the
 *  Connected section renders. */
export const CONNECTION_STATUS_LABELS = {
  connected: 'Connected',
  needsReconnect: 'Needs Reconnect',
  awaitingApproval: 'Waiting for approval',
} as const;

// ── knowledge.json ──────────────────────────────────────────────────────

export const KNOWLEDGE_KEYS = {
  title: 'Title',
  link: 'Link',
  /** Plan copy: the source connector is shown as an icon. */
  source: 'Source',
  /** Plan copy: the page's two section headings, below. */
  section: 'Section',
  added: 'Added',
} as const;

/** src/pages/Dashboard/KnowledgePage.tsx:612 and :627. */
export const KNOWLEDGE_SECTION_LABELS = {
  help_center: 'Help Center',
  document: 'Documents',
} as const;

/** src/config/knowledgeConnectors.ts:4-6. */
export const HELP_CENTER_CONNECTOR_TYPES: ReadonlySet<string> = new Set(['zendesk', 'intercom']);

/** src/config/knowledgeConnectors.ts:11-20. */
export const DOCUMENT_CONNECTOR_TYPES: ReadonlySet<string> = new Set([
  'google_drive',
  'microsoft_onedrive',
  'microsoft_sharepoint',
  'microsoft_onenote',
  'dropbox',
  'box',
  'atlassian_confluence',
  'notion',
]);

// ── review.json ─────────────────────────────────────────────────────────

export const REVIEW_KEYS = {
  /** The heading on every card (ReviewQueuePage.tsx:104-108, `agentLabel`). */
  aiTeam: 'Agent',
  /** "Requested <time>" (ReviewQueuePage.tsx:455). */
  requested: 'Requested',
  /** The level chip (ReviewQueuePage.tsx:53-56). */
  level: 'Level',
  /** The reason line (ReviewQueuePage.tsx:71-81). */
  reason: 'Reason',
  /** ReviewQueuePage.tsx:462. */
  requestedActions: 'Requested Actions',
  /** "Why:" (ReviewQueuePage.tsx:472). */
  why: 'Why',
  /** Plan copy: the stored detail line, and a call's argument rows. */
  details: 'Details',
  status: 'Status',
  /** Plan copy. */
  decidedBy: 'Decided by',
  decided: 'Decided',
  /** "Rejection reason (optional)" (ReviewQueuePage.tsx:593). */
  rejectionReason: 'Rejection reason',
  /** Plan copy, for the late-feedback form (ReviewQueuePage.tsx:563). */
  feedbackAfterWindow: 'Feedback after the window',
  wouldHave: 'Would have',
  by: 'By',
  sent: 'Sent',
  /** "Asked <time>" (ReviewQueuePage.tsx:767). */
  asked: 'Asked',
  /** ReviewQueuePage.tsx:774. */
  question: 'Question',
  answeredBy: 'Answered by',
  answered: 'Answered',
  declinedBy: 'Declined by',
  declined: 'Declined',
  /** A call's connector and action (ToolCallDetails.tsx:73-81, `describeToolCall`). */
  app: 'App',
  action: 'Action',
  /** ToolCallDetails.tsx:83. */
  changedByApprover: 'Changed by the approver',
} as const;

/** ReviewQueuePage.tsx:53-56 (`levelLabels`); other levels carry no badge. */
export const LEVEL_LABELS: Record<number, string> = {
  1: 'Standard',
  2: 'Critical',
};

/** ReviewQueuePage.tsx:71-81 (`reasonLabels`). */
export const REASON_LABELS: Record<string, string> = {
  level_1_gate: 'Full review required',
  destructive_gate: 'High-impact change',
  super_destructive_gate: 'Critical change',
  sensitive_work: 'Sensitive action',
  communication_review: 'Review before sending',
  rate_limit_exceeded: 'Rate limit exceeded',
  merge_to_main: 'Merge to main branch',
  external_content_write: 'Acting on outside content',
  blast_radius: 'Large-scale change',
};

/** ReviewQueuePage.tsx:90 (`reasonLabel`), the degrade word for a reason this
 *  build has not been taught. */
export const UNKNOWN_REASON = 'Needs review';

/** Approval outcomes. "Passed" is the queue's segment (ReviewQueuePage.tsx:198);
 *  "Approved" / "Rejected" are the decision words; "Withdrawn" and "Awaiting
 *  decision" are plan copy, since the queue hides those rows. */
export const APPROVAL_STATUS_LABELS = {
  approved: 'Approved',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
  awaiting: 'Awaiting decision',
  passed: 'Passed',
} as const;

/** Clarification outcomes. "Answered" / "Declined" are the decision words;
 *  "Cancelled", "Failed", "Resolved" and "Awaiting answer" are plan copy. */
export const CLARIFICATION_STATUS_LABELS = {
  answered: 'Answered',
  declined: 'Declined',
  passed: 'Passed',
  cancelled: 'Cancelled',
  failed: 'Failed',
  resolved: 'Resolved',
  awaiting: 'Awaiting answer',
} as const;

/** The late-feedback decision, as the two decision words. */
export const WOULD_HAVE_LABELS: Record<string, string> = {
  would_approve: 'Approved',
  would_reject: 'Rejected',
};

/** ReviewQueuePage.tsx:107: a review item whose team the runtime no longer knows. */
export const UNKNOWN_AI_TEAM = 'Unknown agent';

// ── members.json ────────────────────────────────────────────────────────

export const MEMBER_KEYS = {
  name: 'Name',
  email: 'Email',
  /** The role dropdown (SettingsPage.tsx:276-282). */
  role: 'Role',
  joined: 'Joined',
  /** "Works with A and B" (TeamsPage.tsx:947-953). */
  worksWith: 'Works with',
  invited: 'Invited',
} as const;

/** SettingsPage.tsx:281: `role.charAt(0).toUpperCase() + role.slice(1)`. */
export const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  viewer: 'Viewer',
};

// ── Hidden ──────────────────────────────────────────────────────────────

/** src/utils/toolCallDetails.ts:203 and :262: what a secret-bearing argument
 *  renders as. Also what an internal identifier with no resolved name, and
 *  any subtree past the port's depth limit, render as. */
export const HIDDEN = 'Hidden';
