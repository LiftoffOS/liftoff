// clicksend overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const CLICKSEND_OVERLAYS: Record<string, ComposioToolOverlay> = {
  CLICKSEND_CREATE_SMS_SEND: { stableName: 'send_sms', categoryOverrides: ["write","outbound"] },
  CLICKSEND_CREATE_MMS_SEND: { stableName: 'send_mms', categoryOverrides: ["write","outbound"] },
  CLICKSEND_CREATE_SMS_CAMPAIGNS_SEND: { stableName: 'send_sms_campaign', categoryOverrides: ["write","outbound"] },
  CLICKSEND_CREATE_LISTS: { stableName: 'create_contact_list', categoryOverrides: ["write"] },
  CLICKSEND_CREATE_LISTS_CONTACTS: { stableName: 'add_contact_to_list', categoryOverrides: ["write"] },
  CLICKSEND_CREATE_SMS_TEMPLATES: { stableName: 'create_sms_template', categoryOverrides: ["write"] },
};

export const CLICKSEND_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
