// googleslides overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const GOOGLESLIDES_OVERLAYS: Record<string, ComposioToolOverlay> = {
  GOOGLESLIDES_PRESENTATIONS_CREATE: { stableName: 'create_presentation', categoryOverrides: ["write"] },
  GOOGLESLIDES_CREATE_SLIDES_MARKDOWN: { stableName: 'create_slides_from_markdown', categoryOverrides: ["write"] },
  GOOGLESLIDES_PRESENTATIONS_BATCH_UPDATE: { stableName: 'update_presentation', categoryOverrides: ["write"] },
  GOOGLESLIDES_PRESENTATIONS_GET: { stableName: 'get_presentation', categoryOverrides: ["read"] },
  GOOGLESLIDES_PRESENTATIONS_PAGES_GET: { stableName: 'get_page', categoryOverrides: ["read"] },
  GOOGLESLIDES_PRESENTATIONS_PAGES_GET_THUMBNAIL: { stableName: 'get_page_thumbnail', categoryOverrides: ["read"] },
};

export const GOOGLESLIDES_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
