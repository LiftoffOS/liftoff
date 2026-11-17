// active_campaign overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const ACTIVE_CAMPAIGN_OVERLAYS: Record<string, ComposioToolOverlay> = {
  ACTIVE_CAMPAIGN_LIST_ALL_CONTACTS: { stableName: 'list_contacts', categoryOverrides: ["read"] },
  ACTIVE_CAMPAIGN_FIND_CONTACT: { stableName: 'find_contact', categoryOverrides: ["read"] },
  ACTIVE_CAMPAIGN_CREATE_CONTACT: { stableName: 'create_contact', categoryOverrides: ["write"] },
  ACTIVE_CAMPAIGN_ADD_CONTACT_NOTE: { stableName: 'add_contact_note', categoryOverrides: ["write"] },
  ACTIVE_CAMPAIGN_MANAGE_CONTACT_TAG: { stableName: 'manage_contact_tag', categoryOverrides: ["write"] },
  ACTIVE_CAMPAIGN_MANAGE_LIST_SUBSCRIPTION: { stableName: 'manage_list_subscription', categoryOverrides: ["write"] },
  ACTIVE_CAMPAIGN_ADD_CONTACT_TO_AUTOMATION: { stableName: 'add_contact_to_automation', categoryOverrides: ["write"] },
  ACTIVE_CAMPAIGN_REMOVE_CONTACT_FROM_AUTOMATION: { stableName: 'remove_contact_from_automation', categoryOverrides: ["write"] },
  ACTIVE_CAMPAIGN_CREATE_CONTACT_TASK: { stableName: 'create_contact_task', categoryOverrides: ["write"] },
  ACTIVE_CAMPAIGN_TRACK_EVENT: { stableName: 'track_event', categoryOverrides: ["write"] },
  ACTIVE_CAMPAIGN_CREATE_ACCOUNT: { stableName: 'create_account', categoryOverrides: ["write"] },
  ACTIVE_CAMPAIGN_UPSERT_ACCOUNT: { stableName: 'upsert_account', categoryOverrides: ["write"] },
};

export const ACTIVE_CAMPAIGN_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
