// jira overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const JIRA_OVERLAYS: Record<string, ComposioToolOverlay> = {
  JIRA_SEARCH_FOR_ISSUES_USING_JQL_GET: { stableName: 'search_issues', categoryOverrides: ["read"] },
  JIRA_GET_ISSUE: { stableName: 'get_issue', categoryOverrides: ["read"] },
  JIRA_GET_ISSUE_TYPES: { stableName: 'list_issue_types', categoryOverrides: ["read"] },
  JIRA_GET_ISSUE_WORKLOGS: { stableName: 'list_issue_worklogs', categoryOverrides: ["read"] },
  JIRA_GET_ISSUE_RESOLUTIONS: { stableName: 'list_issue_resolutions', categoryOverrides: ["read"] },
  JIRA_CREATE_ISSUE: { stableName: 'create_issue', categoryOverrides: ["write"] },
  JIRA_ADD_COMMENT: { stableName: 'add_comment', categoryOverrides: ["write"] },
  JIRA_CREATE_ISSUE_LINK: { stableName: 'link_issues', categoryOverrides: ["write"] },
};

export const JIRA_HISTORY_MAPPINGS: HistoryToolMapping[] = [
  {
    entityType: 'comments',
    stableName: 'read_comments',
    // Real Composio slug (the pre-existing overlay used JIRA_GET_ISSUE_COMMENTS,
    // which does not exist in Composio — corrected to JIRA_LIST_ISSUE_COMMENTS).
    vendorToolName: 'JIRA_LIST_ISSUE_COMMENTS',
    translateInput: (a) => ({ issue_id_or_key: (a as { id?: unknown }).id }),
    translateOutput: (r) => {
      const resp = r as { comments?: Array<{ id: string; body?: string }> };
      return { items: (resp.comments ?? []).map((c) => ({ id: c.id, body: c.body ?? '' })) };
    },
  },
];
