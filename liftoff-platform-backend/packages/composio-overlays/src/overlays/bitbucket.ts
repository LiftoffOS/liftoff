// bitbucket overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const BITBUCKET_OVERLAYS: Record<string, ComposioToolOverlay> = {
  BITBUCKET_LIST_REPOSITORIES_IN_WORKSPACE: { stableName: 'list_repositories', categoryOverrides: ["read"] },
  BITBUCKET_LIST_WORKSPACES: { stableName: 'list_workspaces', categoryOverrides: ["read"] },
  BITBUCKET_GET_FILE_FROM_REPOSITORY: { stableName: 'get_file', categoryOverrides: ["read"] },
  BITBUCKET_LIST_PULL_REQUESTS: { stableName: 'list_pull_requests', categoryOverrides: ["read"] },
  BITBUCKET_GET_PULL_REQUEST: { stableName: 'get_pull_request', categoryOverrides: ["read"] },
  BITBUCKET_CREATE_PULL_REQUEST: { stableName: 'create_pull_request', categoryOverrides: ["write"] },
  BITBUCKET_CREATE_BRANCH: { stableName: 'create_branch', categoryOverrides: ["write"] },
  BITBUCKET_CREATE_ISSUE: { stableName: 'create_issue', categoryOverrides: ["write"] },
  BITBUCKET_UPDATE_ISSUE: { stableName: 'update_issue', categoryOverrides: ["write"] },
  BITBUCKET_CREATE_ISSUE_COMMENT: { stableName: 'create_issue_comment', categoryOverrides: ["write"] },
  BITBUCKET_GET_CURRENT_USER: { stableName: 'get_current_user', categoryOverrides: ["read"] },
  BITBUCKET_LIST_WORKSPACE_MEMBERS: { stableName: 'list_workspace_members', categoryOverrides: ["read"] },
};

export const BITBUCKET_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
