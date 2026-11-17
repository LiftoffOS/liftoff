// codacy overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const CODACY_OVERLAYS: Record<string, ComposioToolOverlay> = {
  CODACY_LIST_PROJECTS: { stableName: 'list_projects', categoryOverrides: ["read"] },
  CODACY_GET_ORGANIZATION_REPOSITORIES: { stableName: 'list_organization_repositories', categoryOverrides: ["read"] },
  CODACY_GET_USER_ORGANIZATIONS: { stableName: 'list_organizations', categoryOverrides: ["read"] },
  CODACY_GET_ACCOUNT_DETAILS: { stableName: 'get_account_details', categoryOverrides: ["read"] },
};

export const CODACY_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
