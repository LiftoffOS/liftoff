// workable overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const WORKABLE_OVERLAYS: Record<string, ComposioToolOverlay> = {
  WORKABLE_GET_JOBS: { stableName: 'list_jobs', categoryOverrides: ["read"] },
  WORKABLE_GET_CANDIDATES: { stableName: 'list_candidates', categoryOverrides: ["read"] },
  WORKABLE_GET_MEMBERS: { stableName: 'list_members', categoryOverrides: ["read"] },
  WORKABLE_GET_RECRUITERS: { stableName: 'list_recruiters', categoryOverrides: ["read"] },
  WORKABLE_GET_STAGES: { stableName: 'list_stages', categoryOverrides: ["read"] },
  WORKABLE_GET_REQUISITIONS: { stableName: 'list_requisitions', categoryOverrides: ["read"] },
  WORKABLE_GET_EVENTS: { stableName: 'list_events', categoryOverrides: ["read"] },
  WORKABLE_GET_ACCOUNTS: { stableName: 'list_accounts', categoryOverrides: ["read"] },
  WORKABLE_GET_ACCOUNT: { stableName: 'get_account', categoryOverrides: ["read"] },
};

export const WORKABLE_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
