// fillout_forms overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const FILLOUT_FORMS_OVERLAYS: Record<string, ComposioToolOverlay> = {
  FILLOUT_FORMS_GET_FORMS: { stableName: 'list_forms', categoryOverrides: ["read"] },
};

export const FILLOUT_FORMS_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
