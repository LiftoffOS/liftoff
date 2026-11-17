// imgbb overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const IMGBB_OVERLAYS: Record<string, ComposioToolOverlay> = {
  IMGBB_UPLOAD_IMAGE: { stableName: 'upload_image', categoryOverrides: ["write"] },
};

export const IMGBB_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
