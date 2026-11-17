// peopledatalabs overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const PEOPLEDATALABS_OVERLAYS: Record<string, ComposioToolOverlay> = {
  PEOPLEDATALABS_ENRICH_PERSON_DATA: { stableName: 'enrich_person', categoryOverrides: ["read","sensitive"] },
  PEOPLEDATALABS_IDENTIFY_PERSON_DATA: { stableName: 'identify_person', categoryOverrides: ["read","sensitive"] },
  PEOPLEDATALABS_PEOPLE_SEARCH_ELASTIC: { stableName: 'search_people', categoryOverrides: ["read","sensitive"] },
  PEOPLEDATALABS_ENRICH_COMPANY_DATA: { stableName: 'enrich_company', categoryOverrides: ["read"] },
  PEOPLEDATALABS_COMPANY_SEARCH_ELASTIC: { stableName: 'search_companies', categoryOverrides: ["read"] },
  PEOPLEDATALABS_ENRICH_IP_DATA: { stableName: 'enrich_ip', categoryOverrides: ["read"] },
  PEOPLEDATALABS_ENRICH_JOB_TITLE_DATA: { stableName: 'enrich_job_title', categoryOverrides: ["read"] },
  PEOPLEDATALABS_AUTOCOMPLETE_FIELD_SUGGESTIONS: { stableName: 'autocomplete_fields', categoryOverrides: ["read"] },
};

export const PEOPLEDATALABS_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
