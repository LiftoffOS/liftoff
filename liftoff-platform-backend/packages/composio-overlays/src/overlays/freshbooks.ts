// freshbooks overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const FRESHBOOKS_OVERLAYS: Record<string, ComposioToolOverlay> = {
  FRESHBOOKS_LIST_BUSINESSES: { stableName: 'list_businesses', categoryOverrides: ["read"] },
  FRESHBOOKS_LIST_PROJECTS: { stableName: 'list_projects', categoryOverrides: ["read"] },
};

export const FRESHBOOKS_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
