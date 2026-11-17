// monday overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const MONDAY_OVERLAYS: Record<string, ComposioToolOverlay> = {
  MONDAY_LIST_BOARDS: { stableName: 'list_boards', categoryOverrides: ["read"] },
  MONDAY_LIST_BOARD_ITEMS: { stableName: 'list_board_items', categoryOverrides: ["read"] },
  MONDAY_LIST_ITEMS: { stableName: 'list_items', categoryOverrides: ["read"] },
  MONDAY_LIST_COLUMNS: { stableName: 'list_columns', categoryOverrides: ["read"] },
  MONDAY_LIST_USERS: { stableName: 'list_users', categoryOverrides: ["read"] },
  MONDAY_GET_GROUP_DETAILS: { stableName: 'get_group', categoryOverrides: ["read"] },
  MONDAY_CREATE_ITEM: { stableName: 'create_item', categoryOverrides: ["write"] },
  MONDAY_CREATE_BOARD: { stableName: 'create_board', categoryOverrides: ["write"] },
  MONDAY_CREATE_GROUP: { stableName: 'create_group', categoryOverrides: ["write"] },
  MONDAY_CREATE_COLUMN: { stableName: 'create_column', categoryOverrides: ["write"] },
  MONDAY_CHANGE_SIMPLE_COLUMN_VALUE: { stableName: 'update_column_value', categoryOverrides: ["write"] },
  MONDAY_MOVE_ITEM_TO_GROUP: { stableName: 'move_item_to_group', categoryOverrides: ["write"] },
};

export const MONDAY_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
