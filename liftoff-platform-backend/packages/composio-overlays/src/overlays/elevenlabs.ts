// elevenlabs overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const ELEVENLABS_OVERLAYS: Record<string, ComposioToolOverlay> = {
  ELEVENLABS_ELEVENLABS_TEXT_TO_SPEECH: { stableName: 'text_to_speech', categoryOverrides: ["read"] },
  ELEVENLABS_GET_MODELS: { stableName: 'list_models', categoryOverrides: ["read"] },
  ELEVENLABS_GET_PROJECTS: { stableName: 'list_projects', categoryOverrides: ["read"] },
  ELEVENLABS_GET_PROJECT_BY_ID: { stableName: 'get_project', categoryOverrides: ["read"] },
  ELEVENLABS_DUB_A_VIDEO_OR_AN_AUDIO_FILE: { stableName: 'dub_media', categoryOverrides: ["read"] },
  ELEVENLABS_GET_DUBBED_FILE: { stableName: 'get_dubbed_file', categoryOverrides: ["read"] },
  ELEVENLABS_ADD_VOICE: { stableName: 'add_voice', categoryOverrides: ["write"] },
  ELEVENLABS_GET_GENERATED_ITEMS: { stableName: 'list_generated_items', categoryOverrides: ["read"] },
  ELEVENLABS_GET_HISTORY_ITEM_BY_ID: { stableName: 'get_history_item', categoryOverrides: ["read"] },
};

export const ELEVENLABS_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
