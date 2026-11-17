// telegram overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const TELEGRAM_OVERLAYS: Record<string, ComposioToolOverlay> = {
  TELEGRAM_GET_CHAT: { stableName: 'get_chat', categoryOverrides: ["read"] },
  TELEGRAM_GET_CHAT_HISTORY: { stableName: 'get_chat_history', categoryOverrides: ["read"] },
  TELEGRAM_GET_UPDATES: { stableName: 'get_updates', categoryOverrides: ["read"] },
  TELEGRAM_GET_ME: { stableName: 'get_bot_info', categoryOverrides: ["read"] },
  TELEGRAM_SEND_MESSAGE: { stableName: 'send_message', categoryOverrides: ["write","outbound"] },
  TELEGRAM_SEND_PHOTO: { stableName: 'send_photo', categoryOverrides: ["write","outbound"] },
  TELEGRAM_SEND_DOCUMENT: { stableName: 'send_document', categoryOverrides: ["write","outbound"] },
  TELEGRAM_FORWARD_MESSAGE: { stableName: 'forward_message', categoryOverrides: ["write","outbound"] },
  TELEGRAM_EDIT_MESSAGE: { stableName: 'edit_message', categoryOverrides: ["write"] },
};

export const TELEGRAM_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
