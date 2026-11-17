// airtable overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const AIRTABLE_OVERLAYS: Record<string, ComposioToolOverlay> = {
  AIRTABLE_LIST_BASES: { stableName: 'list_bases', categoryOverrides: ["read"] },
  AIRTABLE_GET_BASE_SCHEMA: { stableName: 'get_base_schema', categoryOverrides: ["read"] },
  AIRTABLE_LIST_RECORDS: { stableName: 'list_records', categoryOverrides: ["read"] },
  AIRTABLE_GET_RECORD: { stableName: 'get_record', categoryOverrides: ["read"] },
  AIRTABLE_LIST_COMMENTS: { stableName: 'list_comments', categoryOverrides: ["read"] },
  AIRTABLE_CREATE_RECORD: { stableName: 'create_record', categoryOverrides: ["write"] },
  AIRTABLE_CREATE_MULTIPLE_RECORDS: { stableName: 'create_records', categoryOverrides: ["write"] },
  AIRTABLE_UPDATE_RECORD: { stableName: 'update_record', categoryOverrides: ["write"] },
  AIRTABLE_CREATE_TABLE: { stableName: 'create_table', categoryOverrides: ["write"] },
  AIRTABLE_CREATE_COMMENT: { stableName: 'create_comment', categoryOverrides: ["write"] },
};

export const AIRTABLE_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
