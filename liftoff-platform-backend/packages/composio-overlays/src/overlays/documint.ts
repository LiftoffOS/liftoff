// documint overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const DOCUMINT_OVERLAYS: Record<string, ComposioToolOverlay> = {
  DOCUMINT_LIST_DOCUMENTS: { stableName: 'list_documents', categoryOverrides: ["read"] },
  DOCUMINT_LIST_TEMPLATES: { stableName: 'list_templates', categoryOverrides: ["read"] },
  DOCUMINT_GET_TEMPLATE: { stableName: 'get_template', categoryOverrides: ["read"] },
  DOCUMINT_UPDATE_TEMPLATE: { stableName: 'update_template', categoryOverrides: ["write"] },
};

export const DOCUMINT_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
