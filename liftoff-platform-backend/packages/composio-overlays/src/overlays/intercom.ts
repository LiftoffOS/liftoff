// intercom overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const INTERCOM_OVERLAYS: Record<string, ComposioToolOverlay> = {
  INTERCOM_GET_A_CONTACT: { stableName: 'get_contact', categoryOverrides: ["read"] },
  INTERCOM_SEARCH_CONVERSATIONS: { stableName: 'search_conversations', categoryOverrides: ["read"] },
  INTERCOM_GET_CONVERSATION: { stableName: 'get_conversation', categoryOverrides: ["read"] },
  INTERCOM_LIST_ALL_COMPANIES: { stableName: 'list_companies', categoryOverrides: ["read"] },
  INTERCOM_LIST_ALL_ARTICLES: { stableName: 'list_articles', categoryOverrides: ["read"] },
  INTERCOM_SEARCH_FOR_ARTICLES: { stableName: 'search_articles', categoryOverrides: ["read"] },
  INTERCOM_REPLY_TO_CONVERSATION: { stableName: 'reply_to_conversation', categoryOverrides: ["write","outbound"] },
  INTERCOM_CREATE_CONVERSATION: { stableName: 'create_conversation', categoryOverrides: ["write","outbound"] },
  INTERCOM_CREATE_A_NOTE: { stableName: 'create_note', categoryOverrides: ["write"] },
  INTERCOM_CREATE_OR_UPDATE_A_COMPANY: { stableName: 'upsert_company', categoryOverrides: ["write"] },
  INTERCOM_ADD_TAG_TO_A_CONTACT: { stableName: 'add_tag_to_contact', categoryOverrides: ["write"] },
  INTERCOM_ASSIGN_CONVERSATION: { stableName: 'assign_conversation', categoryOverrides: ["write"] },
  INTERCOM_CLOSE_CONVERSATION: { stableName: 'close_conversation', categoryOverrides: ["write"] },
};

export const INTERCOM_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
