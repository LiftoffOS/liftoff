// freshdesk overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const FRESHDESK_OVERLAYS: Record<string, ComposioToolOverlay> = {
  FRESHDESK_LIST_ALL_TICKETS: { stableName: 'list_tickets', categoryOverrides: ["read"] },
  FRESHDESK_VIEW_TICKET: { stableName: 'get_ticket', categoryOverrides: ["read"] },
  FRESHDESK_GET_TICKETS: { stableName: 'search_tickets', categoryOverrides: ["read"] },
  FRESHDESK_CREATE_TICKET: { stableName: 'create_ticket', categoryOverrides: ["write"] },
  FRESHDESK_UPDATE_TICKET: { stableName: 'update_ticket', categoryOverrides: ["write"] },
  FRESHDESK_REPLY_TICKET: { stableName: 'reply_ticket', categoryOverrides: ["write","outbound"] },
};

export const FRESHDESK_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
