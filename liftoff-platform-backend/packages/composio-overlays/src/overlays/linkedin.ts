// linkedin overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const LINKEDIN_OVERLAYS: Record<string, ComposioToolOverlay> = {
  LINKEDIN_CREATE_LINKED_IN_POST: { stableName: 'create_post', categoryOverrides: ["write","outbound"] },
  LINKEDIN_GET_COMPANY_INFO: { stableName: 'get_company_info', categoryOverrides: ["read"] },
  LINKEDIN_GET_MY_INFO: { stableName: 'get_current_user', categoryOverrides: ["read"] },
};

export const LINKEDIN_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
