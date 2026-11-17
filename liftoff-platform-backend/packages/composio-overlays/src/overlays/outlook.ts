// outlook overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const OUTLOOK_OVERLAYS: Record<string, ComposioToolOverlay> = {
  OUTLOOK_OUTLOOK_LIST_MESSAGES: { stableName: 'list_messages', categoryOverrides: ["read"] },
  OUTLOOK_OUTLOOK_GET_MESSAGE: { stableName: 'get_message', categoryOverrides: ["read"] },
  OUTLOOK_OUTLOOK_SEARCH_MESSAGES: { stableName: 'search_messages', categoryOverrides: ["read"] },
  OUTLOOK_OUTLOOK_LIST_CONTACTS: { stableName: 'list_contacts', categoryOverrides: ["read"] },
  OUTLOOK_OUTLOOK_GET_CONTACT: { stableName: 'get_contact', categoryOverrides: ["read"] },
  OUTLOOK_OUTLOOK_LIST_EVENTS: { stableName: 'list_events', categoryOverrides: ["read"] },
  OUTLOOK_OUTLOOK_GET_EVENT: { stableName: 'get_event', categoryOverrides: ["read"] },
  OUTLOOK_OUTLOOK_GET_PROFILE: { stableName: 'get_profile', categoryOverrides: ["read"] },
  OUTLOOK_OUTLOOK_SEND_EMAIL: { stableName: 'send_message', categoryOverrides: ["write","outbound"] },
  OUTLOOK_OUTLOOK_REPLY_EMAIL: { stableName: 'reply_to_message', categoryOverrides: ["write","outbound"] },
  OUTLOOK_OUTLOOK_CREATE_DRAFT: { stableName: 'create_draft', categoryOverrides: ["write"] },
  OUTLOOK_OUTLOOK_CALENDAR_CREATE_EVENT: { stableName: 'create_event', categoryOverrides: ["write"] },
  OUTLOOK_OUTLOOK_CREATE_CONTACT: { stableName: 'create_contact', categoryOverrides: ["write"] },
  OUTLOOK_LIST_OUTLOOK_ATTACHMENTS: { stableName: 'list_attachments', categoryOverrides: ["read"] },
  OUTLOOK_DOWNLOAD_OUTLOOK_ATTACHMENT: { stableName: 'download_attachment', categoryOverrides: ["read"] },
  OUTLOOK_ADD_MAIL_ATTACHMENT: { stableName: 'add_attachment', categoryOverrides: ["write"] },
};

export const OUTLOOK_HISTORY_MAPPINGS: HistoryToolMapping[] = [
  {
    // Read all messages in an Outlook conversation. Implemented via the real
    // OUTLOOK_OUTLOOK_LIST_MESSAGES tool filtered by conversationId + ordered
    // chronologically (mirrors gmail's read_thread). The pre-existing overlay
    // used OUTLOOK_GET_CONVERSATION_MESSAGES, which does not exist in Composio.
    entityType: 'conversation',
    stableName: 'read_conversation',
    vendorToolName: 'OUTLOOK_OUTLOOK_LIST_MESSAGES',
    translateInput: (a) => {
      const i = a as { id?: unknown; conversationId?: unknown };
      return { conversationId: i.conversationId ?? i.id, orderby: 'receivedDateTime asc', top: 100 };
    },
    translateOutput: (r) => {
      const resp = r as { value?: unknown[]; response_data?: { value?: unknown[] } };
      const msgs = resp.value ?? resp.response_data?.value ?? [];
      return {
        items: (msgs as Array<{ id?: string; subject?: string; from?: unknown; bodyPreview?: string; receivedDateTime?: string }>).map((m) => ({
          id: m.id ?? '',
          subject: m.subject ?? '',
          from: m.from,
          preview: m.bodyPreview ?? '',
          receivedDateTime: m.receivedDateTime ?? '',
        })),
      };
    },
  },
];
