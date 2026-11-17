// facebook overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const FACEBOOK_OVERLAYS: Record<string, ComposioToolOverlay> = {
  FACEBOOK_GET_USER_PAGES: { stableName: 'list_pages', categoryOverrides: ["read"] },
  FACEBOOK_GET_PAGE_POSTS: { stableName: 'list_page_posts', categoryOverrides: ["read"] },
  FACEBOOK_GET_POST: { stableName: 'get_post', categoryOverrides: ["write"] },
  FACEBOOK_GET_COMMENTS: { stableName: 'list_comments', categoryOverrides: ["read"] },
  FACEBOOK_GET_PAGE_INSIGHTS: { stableName: 'get_page_insights', categoryOverrides: ["read"] },
  FACEBOOK_GET_PAGE_CONVERSATIONS: { stableName: 'list_conversations', categoryOverrides: ["read"] },
  FACEBOOK_GET_CONVERSATION_MESSAGES: { stableName: 'list_conversation_messages', categoryOverrides: ["read"] },
  FACEBOOK_CREATE_POST: { stableName: 'create_post', categoryOverrides: ["write"] },
  FACEBOOK_CREATE_PHOTO_POST: { stableName: 'create_photo_post', categoryOverrides: ["write"] },
  FACEBOOK_UPDATE_POST: { stableName: 'update_post', categoryOverrides: ["write"] },
  FACEBOOK_CREATE_COMMENT: { stableName: 'create_comment', categoryOverrides: ["write"] },
  FACEBOOK_SEND_MESSAGE: { stableName: 'send_message', categoryOverrides: ["write","outbound"] },
  FACEBOOK_LIKE_POST_OR_COMMENT: { stableName: 'like', categoryOverrides: ["write"] },
};

export const FACEBOOK_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
