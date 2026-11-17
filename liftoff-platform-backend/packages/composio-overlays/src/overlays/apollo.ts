// apollo overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const APOLLO_OVERLAYS: Record<string, ComposioToolOverlay> = {
  APOLLO_PEOPLE_SEARCH: { stableName: 'search_people', categoryOverrides: ["read"] },
  APOLLO_ORGANIZATION_SEARCH: { stableName: 'search_organizations', categoryOverrides: ["read"] },
  APOLLO_PEOPLE_ENRICHMENT: { stableName: 'enrich_person', categoryOverrides: ["read"] },
  APOLLO_ORGANIZATION_ENRICHMENT: { stableName: 'enrich_organization', categoryOverrides: ["read"] },
  APOLLO_SEARCH_CONTACTS: { stableName: 'search_contacts', categoryOverrides: ["read"] },
  APOLLO_SEARCH_ACCOUNTS: { stableName: 'search_accounts', categoryOverrides: ["read"] },
  APOLLO_CREATE_CONTACT: { stableName: 'create_contact', categoryOverrides: ["write"] },
  APOLLO_UPDATE_CONTACT: { stableName: 'update_contact', categoryOverrides: ["write"] },
  APOLLO_CREATE_ACCOUNT: { stableName: 'create_account', categoryOverrides: ["write"] },
  APOLLO_CREATE_DEAL: { stableName: 'create_deal', categoryOverrides: ["write"] },
  APOLLO_LIST_DEALS: { stableName: 'list_deals', categoryOverrides: ["read"] },
  APOLLO_UPDATE_DEALS: { stableName: 'update_deal', categoryOverrides: ["write"] },
  APOLLO_ADD_CONTACTS_TO_SEQUENCE: { stableName: 'add_contacts_to_sequence', categoryOverrides: ["write"] },
  APOLLO_CREATE_TASK: { stableName: 'create_task', categoryOverrides: ["write"] },
};

export const APOLLO_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
