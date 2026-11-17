// coda overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const CODA_OVERLAYS: Record<string, ComposioToolOverlay> = {
  CODA_LIST_AVAILABLE_DOCS: { stableName: 'list_docs', categoryOverrides: ["read"] },
  CODA_GET_INFO_ABOUT_A_DOC: { stableName: 'get_doc', categoryOverrides: ["read"] },
  CODA_LIST_PAGES: { stableName: 'list_pages', categoryOverrides: ["read"] },
  CODA_GET_A_PAGE: { stableName: 'get_page', categoryOverrides: ["read"] },
  CODA_LIST_TABLES: { stableName: 'list_tables', categoryOverrides: ["read"] },
  CODA_GET_A_TABLE: { stableName: 'get_table', categoryOverrides: ["read"] },
  CODA_LIST_COLUMNS: { stableName: 'list_columns', categoryOverrides: ["read"] },
  CODA_LIST_TABLE_ROWS: { stableName: 'list_table_rows', categoryOverrides: ["read"] },
  CODA_GET_A_ROW: { stableName: 'get_row', categoryOverrides: ["read"] },
  CODA_CREATE_DOC: { stableName: 'create_doc', categoryOverrides: ["write"] },
  CODA_CREATE_A_PAGE: { stableName: 'create_page', categoryOverrides: ["write"] },
  CODA_UPSERT_ROWS: { stableName: 'upsert_rows', categoryOverrides: ["write"] },
};

export const CODA_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
