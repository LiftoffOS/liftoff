// mem overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const MEM_OVERLAYS: Record<string, ComposioToolOverlay> = {
  MEM_READ_NOTE: { stableName: 'get_note', categoryOverrides: ["read"] },
  MEM_CREATE_NOTE: { stableName: 'create_note', categoryOverrides: ["write"] },
  MEM_CREATE_COLLECTION: { stableName: 'create_collection', categoryOverrides: ["write"] },
};

export const MEM_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
