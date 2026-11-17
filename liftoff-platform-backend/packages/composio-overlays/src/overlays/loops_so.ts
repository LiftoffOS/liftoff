// loops_so overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const LOOPS_SO_OVERLAYS: Record<string, ComposioToolOverlay> = {
  LOOPS_SO_FIND_CONTACT: { stableName: 'find_contact', categoryOverrides: ["read"] },
  LOOPS_SO_GET_CONTACT_PROPERTIES: { stableName: 'list_contact_properties', categoryOverrides: ["read"] },
  LOOPS_SO_GET_MAILING_LISTS: { stableName: 'list_mailing_lists', categoryOverrides: ["read"] },
  LOOPS_SO_LIST_TRANSACTIONAL_EMAILS: { stableName: 'list_transactional_emails', categoryOverrides: ["read"] },
  LOOPS_SO_CREATE_CONTACT: { stableName: 'create_contact', categoryOverrides: ["write"] },
  LOOPS_SO_UPDATE_CONTACT: { stableName: 'update_contact', categoryOverrides: ["write"] },
  LOOPS_SO_SEND_EVENT: { stableName: 'send_event', categoryOverrides: ["write"] },
};

export const LOOPS_SO_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
