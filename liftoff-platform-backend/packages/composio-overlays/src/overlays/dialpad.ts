// dialpad overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const DIALPAD_OVERLAYS: Record<string, ComposioToolOverlay> = {
  DIALPAD_SEND_SMS_WITH_OPTIONAL_MEDIA_AND_GROUP_SENDER: { stableName: 'send_sms', categoryOverrides: ["write","outbound"] },
  DIALPAD_LIST_USERS: { stableName: 'list_users', categoryOverrides: ["read"] },
  DIALPAD_CREATE_CALLBACK: { stableName: 'create_callback', categoryOverrides: ["write"] },
  DIALPAD_GET_USER_CALLER_ID: { stableName: 'get_user_caller_id', categoryOverrides: ["read"] },
};

export const DIALPAD_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
