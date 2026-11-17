// saperly overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const SAPERLY_OVERLAYS: Record<string, ComposioToolOverlay> = {
  SAPERLY_PROVISION_NUMBER: { stableName: 'provision_number', categoryOverrides: ["write"] },
  SAPERLY_RELEASE_NUMBER: { stableName: 'release_number', categoryOverrides: ["destructive"] },
  SAPERLY_GET_NUMBER: { stableName: 'get_number', categoryOverrides: ["read"] },
  SAPERLY_LIST_NUMBERS: { stableName: 'list_numbers', categoryOverrides: ["read"] },
  SAPERLY_QUOTE_NUMBER_PRICE: { stableName: 'quote_number_price', categoryOverrides: ["read"] },
  SAPERLY_SET_NUMBER_CALLER_ID: { stableName: 'set_number_caller_id', categoryOverrides: ["write"] },
  SAPERLY_SET_NUMBER_SMS_SENDER: { stableName: 'set_number_sms_sender', categoryOverrides: ["write"] },
  SAPERLY_PLACE_CALL: { stableName: 'place_call', categoryOverrides: ["write","outbound"] },
  SAPERLY_TRANSFER_CALL: { stableName: 'transfer_call', categoryOverrides: ["write","outbound"] },
  SAPERLY_END_CALL: { stableName: 'end_call', categoryOverrides: ["write"] },
  SAPERLY_GET_CALL: { stableName: 'get_call', categoryOverrides: ["read"] },
  SAPERLY_LIST_CALLS: { stableName: 'list_calls', categoryOverrides: ["read"] },
  SAPERLY_GET_CALL_RECORDING: { stableName: 'get_call_recording', categoryOverrides: ["read","sensitive"] },
  SAPERLY_GET_CALL_TRANSCRIPT: { stableName: 'get_call_transcript', categoryOverrides: ["read","sensitive"] },
  SAPERLY_SEND_SMS: { stableName: 'send_sms', categoryOverrides: ["write","outbound"] },
  SAPERLY_LIST_MESSAGES: { stableName: 'list_messages', categoryOverrides: ["read"] },
  SAPERLY_CHECK_CONSENT: { stableName: 'check_consent', categoryOverrides: ["read"] },
  SAPERLY_LIST_CONSENT: { stableName: 'list_consent', categoryOverrides: ["read"] },
  SAPERLY_RECORD_CONSENT: { stableName: 'record_consent', categoryOverrides: ["write"] },
  SAPERLY_REVOKE_CONSENT: { stableName: 'revoke_consent', categoryOverrides: ["write"] },
  SAPERLY_CREATE_CONNECTION: { stableName: 'create_connection', categoryOverrides: ["write"] },
  SAPERLY_GET_CONNECTION: { stableName: 'get_connection', categoryOverrides: ["read"] },
  SAPERLY_LIST_CONNECTIONS: { stableName: 'list_connections', categoryOverrides: ["read"] },
  SAPERLY_UPDATE_CONNECTION: { stableName: 'update_connection', categoryOverrides: ["write"] },
  SAPERLY_DELETE_CONNECTION: { stableName: 'delete_connection', categoryOverrides: ["destructive"] },
  SAPERLY_ASSIGN_NUMBER_CONNECTION: { stableName: 'assign_number_connection', categoryOverrides: ["write"] },
  SAPERLY_GET_USAGE: { stableName: 'get_usage', categoryOverrides: ["read"] },
  SAPERLY_LIST_LANGUAGES: { stableName: 'list_languages', categoryOverrides: ["read"] },
  SAPERLY_LIST_VOICES: { stableName: 'list_voices', categoryOverrides: ["read"] },
};

export const SAPERLY_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
