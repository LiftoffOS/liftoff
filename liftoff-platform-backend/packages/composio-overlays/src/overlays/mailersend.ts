// mailersend overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const MAILERSEND_OVERLAYS: Record<string, ComposioToolOverlay> = {
  MAILERSEND_GET_MESSAGES: { stableName: 'list_messages', categoryOverrides: ["read"] },
  MAILERSEND_GET_RECIPIENTS: { stableName: 'list_recipients', categoryOverrides: ["read"] },
  MAILERSEND_GET_TEMPLATES: { stableName: 'list_templates', categoryOverrides: ["read"] },
  MAILERSEND_GET_DOMAINS: { stableName: 'list_domains', categoryOverrides: ["read"] },
  MAILERSEND_GET_IDENTITIES: { stableName: 'list_sender_identities', categoryOverrides: ["read"] },
  MAILERSEND_GET_SMS_MESSAGES: { stableName: 'list_sms_messages', categoryOverrides: ["read"] },
  MAILERSEND_GET_SMS_ACTIVITY: { stableName: 'get_sms_activity', categoryOverrides: ["read"] },
  MAILERSEND_GET_SMS_RECIPIENTS: { stableName: 'list_sms_recipients', categoryOverrides: ["read"] },
};

export const MAILERSEND_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
