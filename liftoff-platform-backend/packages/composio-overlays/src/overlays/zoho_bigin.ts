// zoho_bigin overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const ZOHO_BIGIN_OVERLAYS: Record<string, ComposioToolOverlay> = {
  ZOHO_BIGIN_GET_RECORDS: { stableName: 'get_records', categoryOverrides: ["read"] },
  ZOHO_BIGIN_GET_RECORD: { stableName: 'get_record', categoryOverrides: ["read"] },
  ZOHO_BIGIN_SEARCH_RECORDS: { stableName: 'search_records', categoryOverrides: ["read"] },
  ZOHO_BIGIN_GET_RECORDS_COUNT: { stableName: 'get_records_count', categoryOverrides: ["read"] },
  ZOHO_BIGIN_GET_DELETED_RECORDS: { stableName: 'get_deleted_records', categoryOverrides: ["read"] },
  ZOHO_BIGIN_ADD_RECORDS: { stableName: 'add_records', categoryOverrides: ["write"] },
  ZOHO_BIGIN_UPDATE_RECORDS: { stableName: 'update_records', categoryOverrides: ["write"] },
  ZOHO_BIGIN_UPSERT_RECORDS: { stableName: 'upsert_records', categoryOverrides: ["write"] },
  ZOHO_BIGIN_DELETE_RECORDS: { stableName: 'delete_records', categoryOverrides: ["write","destructive"] },
  ZOHO_BIGIN_GET_RELATED_RECORDS: { stableName: 'get_related_records', categoryOverrides: ["read"] },
  ZOHO_BIGIN_UPDATE_RELATED_RECORDS: { stableName: 'update_related_records', categoryOverrides: ["write"] },
  ZOHO_BIGIN_GET_TEAM_PIPELINE_RECORDS: { stableName: 'get_pipeline_records', categoryOverrides: ["read"] },
  ZOHO_BIGIN_GET_ALL_NOTES: { stableName: 'list_notes', categoryOverrides: ["read"] },
  ZOHO_BIGIN_CREATE_NOTES: { stableName: 'create_notes', categoryOverrides: ["write"] },
  ZOHO_BIGIN_UPDATE_NOTE: { stableName: 'update_note', categoryOverrides: ["write"] },
  ZOHO_BIGIN_DELETE_NOTE: { stableName: 'delete_note', categoryOverrides: ["write","destructive"] },
  ZOHO_BIGIN_GET_ATTACHMENTS: { stableName: 'get_attachments', categoryOverrides: ["read"] },
  ZOHO_BIGIN_UPLOAD_ATTACHMENT: { stableName: 'upload_attachment', categoryOverrides: ["write"] },
  ZOHO_BIGIN_DOWNLOAD_ATTACHMENT: { stableName: 'download_attachment', categoryOverrides: ["read"] },
  ZOHO_BIGIN_DELETE_ATTACHMENT: { stableName: 'delete_attachment', categoryOverrides: ["write","destructive"] },
  ZOHO_BIGIN_CREATE_TAGS: { stableName: 'create_tags', categoryOverrides: ["write"] },
  ZOHO_BIGIN_ADD_TAGS_TO_RECORDS: { stableName: 'add_tags_to_records', categoryOverrides: ["write"] },
  ZOHO_BIGIN_GET_MODULES: { stableName: 'get_modules', categoryOverrides: ["read"] },
  ZOHO_BIGIN_GET_FIELDS: { stableName: 'get_fields', categoryOverrides: ["read"] },
  ZOHO_BIGIN_GET_USERS: { stableName: 'get_users', categoryOverrides: ["read"] },
  ZOHO_BIGIN_GET_ORGANIZATION: { stableName: 'get_organization', categoryOverrides: ["read"] },
};

export const ZOHO_BIGIN_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
