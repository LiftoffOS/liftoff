// instagram overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const INSTAGRAM_OVERLAYS: Record<string, ComposioToolOverlay> = {
  INSTAGRAM_GET_USER_MEDIA: { stableName: 'list_user_media', categoryOverrides: ["read"] },
  INSTAGRAM_GET_USER_INFO: { stableName: 'get_user_info', categoryOverrides: ["read"] },
  INSTAGRAM_GET_POST_COMMENTS: { stableName: 'list_post_comments', categoryOverrides: ["write"] },
  INSTAGRAM_GET_POST_INSIGHTS: { stableName: 'get_post_insights', categoryOverrides: ["write"] },
  INSTAGRAM_LIST_ALL_CONVERSATIONS: { stableName: 'list_conversations', categoryOverrides: ["read"] },
  INSTAGRAM_LIST_ALL_MESSAGES: { stableName: 'list_messages', categoryOverrides: ["read"] },
  INSTAGRAM_GET_CONVERSATION: { stableName: 'get_conversation', categoryOverrides: ["read"] },
  INSTAGRAM_CREATE_POST: { stableName: 'create_post', categoryOverrides: ["write"] },
  INSTAGRAM_REPLY_TO_COMMENT: { stableName: 'reply_to_comment', categoryOverrides: ["write","outbound"] },
  INSTAGRAM_SEND_TEXT_MESSAGE: { stableName: 'send_message', categoryOverrides: ["write","outbound"] },
  INSTAGRAM_SEND_IMAGE: { stableName: 'send_image', categoryOverrides: ["write","outbound"] },
};

export const INSTAGRAM_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
