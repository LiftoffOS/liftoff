// youtube overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const YOUTUBE_OVERLAYS: Record<string, ComposioToolOverlay> = {
  YOUTUBE_SEARCH_YOU_TUBE: { stableName: 'search', categoryOverrides: ["read"] },
  YOUTUBE_LIST_CHANNEL_VIDEOS: { stableName: 'list_channel_videos', categoryOverrides: ["read"] },
  YOUTUBE_VIDEO_DETAILS: { stableName: 'get_video', categoryOverrides: ["read"] },
  YOUTUBE_GET_CHANNEL_STATISTICS: { stableName: 'get_channel_statistics', categoryOverrides: ["read"] },
  YOUTUBE_GET_CHANNEL_ACTIVITIES: { stableName: 'list_channel_activities', categoryOverrides: ["read"] },
  YOUTUBE_LIST_USER_PLAYLISTS: { stableName: 'list_playlists', categoryOverrides: ["read"] },
  YOUTUBE_LIST_CAPTION_TRACK: { stableName: 'list_captions', categoryOverrides: ["write"] },
  YOUTUBE_LOAD_CAPTIONS: { stableName: 'download_captions', categoryOverrides: ["read"] },
  YOUTUBE_UPDATE_VIDEO: { stableName: 'update_video', categoryOverrides: ["write"] },
  YOUTUBE_SUBSCRIBE_CHANNEL: { stableName: 'subscribe_channel', categoryOverrides: ["write"] },
};

export const YOUTUBE_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
