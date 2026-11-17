// trello overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const TRELLO_OVERLAYS: Record<string, ComposioToolOverlay> = {
  TRELLO_GET_MEMBERS_BOARDS_BY_ID_MEMBER: { stableName: 'list_boards', categoryOverrides: ["read"] },
  TRELLO_GET_BOARDS_BY_ID_BOARD: { stableName: 'get_board', categoryOverrides: ["read"] },
  TRELLO_GET_BOARDS_CARDS_BY_ID_BOARD: { stableName: 'list_board_cards', categoryOverrides: ["read"] },
  TRELLO_GET_BOARDS_LISTS_BY_ID_BOARD: { stableName: 'list_board_lists', categoryOverrides: ["read"] },
  TRELLO_GET_CARDS_BY_ID_CARD: { stableName: 'get_card', categoryOverrides: ["read"] },
  TRELLO_GET_LISTS_CARDS_BY_ID_LIST: { stableName: 'list_list_cards', categoryOverrides: ["read"] },
  TRELLO_ADD_CARDS: { stableName: 'create_card', categoryOverrides: ["write"] },
  TRELLO_ADD_CARDS_ACTIONS_COMMENTS_BY_ID_CARD: { stableName: 'add_card_comment', categoryOverrides: ["write"] },
  TRELLO_ADD_BOARDS: { stableName: 'create_board', categoryOverrides: ["write"] },
};

export const TRELLO_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
