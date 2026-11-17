// googlesheets overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

//
// Write-provenance declarations below are in CANONICAL shape: `idArgs` name
// arguments off each tool's input_parameters, `returnsIds` paths are read
// against `data` off its output_parameters, and nothing here translates either.
//
// The spreadsheet id arrives under both spellings across this toolkit —
// `spreadsheet_id` on the row and value tools, `spreadsheetId` on append,
// add_sheet and the data-filter update. Each is read from its own tool.
import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const GOOGLESHEETS_OVERLAYS: Record<string, ComposioToolOverlay> = {
  GOOGLESHEETS_SEARCH_SPREADSHEETS: {
    stableName: 'search_spreadsheets', categoryOverrides: ["read"],
    returnsIds: [{ entityType: 'spreadsheet', path: 'spreadsheets[].id' }],
  },
  GOOGLESHEETS_GET_SPREADSHEET_INFO: {
    stableName: 'get_spreadsheet_info', categoryOverrides: ["read"],
    returnsIds: [{ entityType: 'spreadsheet', path: 'response_data.spreadsheetId' }],
  },
  GOOGLESHEETS_GET_SHEET_NAMES: { stableName: 'get_sheet_names', categoryOverrides: ["read"] },
  GOOGLESHEETS_BATCH_GET: { stableName: 'batch_get_values', categoryOverrides: ["write"] },
  GOOGLESHEETS_LOOKUP_SPREADSHEET_ROW: { stableName: 'lookup_row', categoryOverrides: ["read"] },
  GOOGLESHEETS_QUERY_TABLE: { stableName: 'query_table', categoryOverrides: ["read"] },
  GOOGLESHEETS_CREATE_GOOGLE_SHEET1: {
    stableName: 'create_spreadsheet', categoryOverrides: ["write"],
    returnsIds: [{ entityType: 'spreadsheet', path: 'response_data.spreadsheetId' }],
  },
  GOOGLESHEETS_CREATE_SPREADSHEET_ROW: {
    stableName: 'create_row', categoryOverrides: ["write"],
    idArgs: ['spreadsheet_id'],
    returnsIds: [{ entityType: 'spreadsheet', path: 'spreadsheet.spreadsheetId' }],
  },
  GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND: {
    stableName: 'append_values', categoryOverrides: ["write"],
    idArgs: ['spreadsheetId'],
    returnsIds: [{ entityType: 'spreadsheet', path: 'spreadsheetId' }],
  },
  GOOGLESHEETS_BATCH_UPDATE_VALUES_BY_DATA_FILTER: {
    stableName: 'batch_update_values', categoryOverrides: ["write"],
    idArgs: ['spreadsheetId'],
    returnsIds: [{ entityType: 'spreadsheet', path: 'spreadsheetId' }],
  },
  GOOGLESHEETS_CLEAR_VALUES: {
    stableName: 'clear_values', categoryOverrides: ["write","destructive"],
    idArgs: ['spreadsheet_id'],
    returnsIds: [{ entityType: 'spreadsheet', path: 'spreadsheetId' }],
  },
  GOOGLESHEETS_ADD_SHEET: {
    stableName: 'add_sheet', categoryOverrides: ["write"],
    idArgs: ['spreadsheetId'],
    returnsIds: [{ entityType: 'spreadsheet', path: 'spreadsheetId' }],
  },
};

export const GOOGLESHEETS_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
