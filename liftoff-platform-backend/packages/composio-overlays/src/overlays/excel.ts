// excel overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const EXCEL_OVERLAYS: Record<string, ComposioToolOverlay> = {
  EXCEL_LIST_WORKSHEETS: { stableName: 'list_worksheets', categoryOverrides: ["read"] },
  EXCEL_GET_WORKSHEET: { stableName: 'get_worksheet', categoryOverrides: ["read"] },
  EXCEL_LIST_TABLES: { stableName: 'list_tables', categoryOverrides: ["read"] },
  EXCEL_GET_RANGE: { stableName: 'get_range', categoryOverrides: ["read"] },
  EXCEL_CREATE_WORKBOOK: { stableName: 'create_workbook', categoryOverrides: ["write"] },
  EXCEL_ADD_WORKSHEET: { stableName: 'add_worksheet', categoryOverrides: ["write"] },
  EXCEL_ADD_TABLE: { stableName: 'add_table', categoryOverrides: ["write"] },
  EXCEL_ADD_TABLE_ROW: { stableName: 'add_table_row', categoryOverrides: ["write"] },
  EXCEL_ADD_TABLE_COLUMN: { stableName: 'add_table_column', categoryOverrides: ["write"] },
  EXCEL_APPLY_TABLE_FILTER: { stableName: 'apply_table_filter', categoryOverrides: ["write"] },
  EXCEL_APPLY_TABLE_SORT: { stableName: 'apply_table_sort', categoryOverrides: ["write"] },
  EXCEL_UPDATE_RANGE: { stableName: 'update_range', categoryOverrides: ["write"] },
  EXCEL_CLEAR_RANGE: { stableName: 'clear_range', categoryOverrides: ["write","destructive"] },
  EXCEL_LIST_TABLE_ROWS: { stableName: 'list_table_rows', categoryOverrides: ["read"] },
  EXCEL_LIST_FILES: { stableName: 'list_files', categoryOverrides: ["read"] },
  EXCEL_LIST_SHAREPOINT_WORKSHEETS: { stableName: 'list_sharepoint_worksheets', categoryOverrides: ["read"] },
  EXCEL_LIST_SHAREPOINT_TABLES: { stableName: 'list_sharepoint_tables', categoryOverrides: ["read"] },
  EXCEL_GET_SHAREPOINT_RANGE: { stableName: 'get_sharepoint_range', categoryOverrides: ["read"] },
  EXCEL_UPDATE_SHAREPOINT_RANGE: { stableName: 'update_sharepoint_range', categoryOverrides: ["write"] },
  EXCEL_ADD_SHAREPOINT_WORKSHEET: { stableName: 'add_sharepoint_worksheet', categoryOverrides: ["write"] },
};

export const EXCEL_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
