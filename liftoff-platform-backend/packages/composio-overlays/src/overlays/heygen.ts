// heygen overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const HEYGEN_OVERLAYS: Record<string, ComposioToolOverlay> = {
  HEYGEN_V2_AVATARS: { stableName: 'list_avatars', categoryOverrides: ["read"] },
  HEYGEN_V1_VIDEO_LIST: { stableName: 'list_videos', categoryOverrides: ["read"] },
  HEYGEN_V1_VIDEO_STATUS_GET_LATEST_ID: { stableName: 'get_video_status', categoryOverrides: ["read"] },
  HEYGEN_V1_VOICE_LIST: { stableName: 'list_voices', categoryOverrides: ["read"] },
  HEYGEN_V2_TEMPLATES: { stableName: 'list_templates', categoryOverrides: ["read"] },
  HEYGEN_V2_TEMPLATE_ID: { stableName: 'get_template', categoryOverrides: ["read"] },
  HEYGEN_V2_TEMPLATE_GENERATE: { stableName: 'generate_video_from_template', categoryOverrides: ["read"] },
  HEYGEN_V1_TALKING_PHOTO_LIST: { stableName: 'list_talking_photos', categoryOverrides: ["read"] },
  HEYGEN_ADD_NEW_ASSET: { stableName: 'add_asset', categoryOverrides: ["write"] },
};

export const HEYGEN_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
