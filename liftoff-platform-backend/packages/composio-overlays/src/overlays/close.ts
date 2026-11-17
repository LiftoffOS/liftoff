// close overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const CLOSE_OVERLAYS: Record<string, ComposioToolOverlay> = {
  CLOSE_CREATE_LEAD: { stableName: 'create_lead', categoryOverrides: ["write"] },
  CLOSE_CREATE_TASK: { stableName: 'create_task', categoryOverrides: ["write"] },
  CLOSE_CREATE_CALL: { stableName: 'create_call', categoryOverrides: ["write"] },
  CLOSE_CLOSE_CREATE_SMS: { stableName: 'send_sms', categoryOverrides: ["write"] },
  CLOSE_GET_NOTE: { stableName: 'get_notes', categoryOverrides: ["write"] },
};

export const CLOSE_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
