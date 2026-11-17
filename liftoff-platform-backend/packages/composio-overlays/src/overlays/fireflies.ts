// fireflies overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const FIREFLIES_OVERLAYS: Record<string, ComposioToolOverlay> = {
  FIREFLIES_GET_TRANSCRIPTS: { stableName: 'list_transcripts', categoryOverrides: ["read"] },
  FIREFLIES_GET_TRANSCRIPT_BY_ID: { stableName: 'get_transcript', categoryOverrides: ["read"] },
  FIREFLIES_GET_BITES: { stableName: 'list_bites', categoryOverrides: ["read"] },
  FIREFLIES_GET_BITE_BY_ID: { stableName: 'get_bite', categoryOverrides: ["read"] },
  FIREFLIES_GET_USERS: { stableName: 'list_users', categoryOverrides: ["read"] },
  FIREFLIES_FETCH_AI_APP_OUTPUTS: { stableName: 'get_ai_outputs', categoryOverrides: ["read"] },
  FIREFLIES_UPLOAD_AUDIO: { stableName: 'upload_audio', categoryOverrides: ["write"] },
};

export const FIREFLIES_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
