// hunter overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const HUNTER_OVERLAYS: Record<string, ComposioToolOverlay> = {
  HUNTER_DOMAIN_SEARCH: { stableName: 'domain_search', categoryOverrides: ["read","sensitive"] },
  HUNTER_EMAIL_FINDER: { stableName: 'find_email', categoryOverrides: ["read","sensitive"] },
  HUNTER_EMAIL_VERIFIER: { stableName: 'verify_email', categoryOverrides: ["read"] },
  HUNTER_COMPANY_ENRICHMENT: { stableName: 'enrich_company', categoryOverrides: ["read"] },
  HUNTER_CREATE_LEAD: { stableName: 'create_lead', categoryOverrides: ["write"] },
  HUNTER_GET_LEAD: { stableName: 'get_lead', categoryOverrides: ["read"] },
  HUNTER_LIST_LEADS: { stableName: 'list_leads', categoryOverrides: ["read"] },
  HUNTER_UPDATE_LEAD: { stableName: 'update_lead', categoryOverrides: ["write"] },
};

export const HUNTER_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
