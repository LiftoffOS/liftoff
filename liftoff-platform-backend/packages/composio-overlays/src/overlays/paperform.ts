// paperform overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const PAPERFORM_OVERLAYS: Record<string, ComposioToolOverlay> = {
  PAPERFORM_LIST_FORMS: { stableName: 'list_forms', categoryOverrides: ["read"] },
  PAPERFORM_LIST_SPACES: { stableName: 'list_spaces', categoryOverrides: ["read"] },
  PAPERFORM_GET_SPACE: { stableName: 'get_space', categoryOverrides: ["read"] },
  PAPERFORM_GET_SPACE_FORMS: { stableName: 'list_space_forms', categoryOverrides: ["read"] },
};

export const PAPERFORM_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
