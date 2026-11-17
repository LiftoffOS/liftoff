// zoho_mail overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const ZOHO_MAIL_OVERLAYS: Record<string, ComposioToolOverlay> = {
  ZOHO_MAIL_MESSAGES_LIST_EMAILS: { stableName: 'list_emails', categoryOverrides: ["read"] },
  ZOHO_MAIL_SEARCH_MESSAGES: { stableName: 'search_messages', categoryOverrides: ["read"] },
  ZOHO_MAIL_MESSAGES_GET_MESSAGE_CONTENT: { stableName: 'get_message_content', categoryOverrides: ["read"] },
  ZOHO_MAIL_MESSAGES_SEND_EMAIL: { stableName: 'send_email', categoryOverrides: ["write","outbound"] },
  ZOHO_MAIL_MESSAGES_REPLY_TO_EMAIL: { stableName: 'reply_to_email', categoryOverrides: ["write","outbound"] },
  ZOHO_MAIL_MESSAGES_CREATE_DRAFT: { stableName: 'create_draft', categoryOverrides: ["write"] },
  ZOHO_MAIL_ACCOUNTS_LIST_ACCOUNTS: { stableName: 'list_accounts', categoryOverrides: ["read"] },
  ZOHO_MAIL_LIST_BOOKMARKS: { stableName: 'list_bookmarks', categoryOverrides: ["read"] },
};

export const ZOHO_MAIL_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
