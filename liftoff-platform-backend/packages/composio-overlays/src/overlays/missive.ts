// missive overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const MISSIVE_OVERLAYS: Record<string, ComposioToolOverlay> = {
  MISSIVE_LIST_TEAMS: { stableName: 'list_teams', categoryOverrides: ["read"] },
  MISSIVE_LIST_TEAM_MEMBERS: { stableName: 'list_team_members', categoryOverrides: ["read"] },
  MISSIVE_LIST_USERS: { stableName: 'list_users', categoryOverrides: ["read"] },
  MISSIVE_CREATE_MESSAGE: { stableName: 'send_message', categoryOverrides: ["write","outbound"] },
  MISSIVE_CREATE_DRAFT: { stableName: 'create_draft', categoryOverrides: ["write"] },
  MISSIVE_CREATE_ANALYTICS_REPORT: { stableName: 'create_analytics_report', categoryOverrides: ["write"] },
};

export const MISSIVE_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
