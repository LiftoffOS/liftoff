// googlemeet overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const GOOGLEMEET_OVERLAYS: Record<string, ComposioToolOverlay> = {
  GOOGLEMEET_CREATE_MEET: { stableName: 'create_meeting', categoryOverrides: ["write"] },
  GOOGLEMEET_GET_MEET: { stableName: 'get_meeting', categoryOverrides: ["read"] },
  GOOGLEMEET_LIST_CONFERENCE_RECORDS: { stableName: 'list_conference_records', categoryOverrides: ["read"] },
  GOOGLEMEET_GET_CONFERENCE_RECORD_FOR_MEET: { stableName: 'get_conference_record', categoryOverrides: ["read"] },
  GOOGLEMEET_GET_RECORDINGS_BY_CONFERENCE_RECORD_ID: { stableName: 'get_recordings', categoryOverrides: ["read"] },
  GOOGLEMEET_GET_TRANSCRIPTS_BY_CONFERENCE_RECORD_ID: { stableName: 'get_transcripts', categoryOverrides: ["read"] },
  GOOGLEMEET_LIST_PARTICIPANT_SESSIONS: { stableName: 'list_participant_sessions', categoryOverrides: ["read"] },
};

export const GOOGLEMEET_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
