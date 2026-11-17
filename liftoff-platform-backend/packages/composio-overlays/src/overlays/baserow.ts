// baserow overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const BASEROW_OVERLAYS: Record<string, ComposioToolOverlay> = {
  BASEROW_LIST_DATABASES: { stableName: 'list_databases', categoryOverrides: ["read"] },
  BASEROW_LIST_TABLES: { stableName: 'list_tables', categoryOverrides: ["read"] },
};

export const BASEROW_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
