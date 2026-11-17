// reddit overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const REDDIT_OVERLAYS: Record<string, ComposioToolOverlay> = {
  REDDIT_RETRIEVE_REDDIT_POST: { stableName: 'list_subreddit_posts', categoryOverrides: ["write"] },
  REDDIT_RETRIEVE_POST_COMMENTS: { stableName: 'list_post_comments', categoryOverrides: ["write"] },
  REDDIT_RETRIEVE_SPECIFIC_COMMENT: { stableName: 'get_comment', categoryOverrides: ["read"] },
  REDDIT_SEARCH_ACROSS_SUBREDDITS: { stableName: 'search', categoryOverrides: ["read"] },
  REDDIT_CREATE_REDDIT_POST: { stableName: 'create_post', categoryOverrides: ["write","outbound"] },
  REDDIT_POST_REDDIT_COMMENT: { stableName: 'post_comment', categoryOverrides: ["write","outbound"] },
  REDDIT_EDIT_REDDIT_COMMENT_OR_POST: { stableName: 'edit_post_or_comment', categoryOverrides: ["write"] },
};

export const REDDIT_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
