// dataforseo overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const DATAFORSEO_OVERLAYS: Record<string, ComposioToolOverlay> = {
  DATAFORSEO_GET_KW_GOOGLE_ADS_KW_FOR_KW_LIVE: { stableName: 'keyword_ideas', categoryOverrides: ["read"] },
  DATAFORSEO_GET_KW_GOOGLE_KW_FOR_CATEGORY_LIVE: { stableName: 'keywords_for_category', categoryOverrides: ["read"] },
  DATAFORSEO_POST_DATAFORSEO_LABS_BULK_KEYWORD_DIFFICULTY_LIVE: { stableName: 'keyword_difficulty', categoryOverrides: ["read"] },
  DATAFORSEO_GET_DATAFORSEO_LABS_GOOGLE_TOP_SEARCHES_LIVE: { stableName: 'top_searches', categoryOverrides: ["read"] },
  DATAFORSEO_GET_DATAFORSEO_LABS_BING_RELATED_KEYWORDS_LIVE: { stableName: 'bing_related_keywords', categoryOverrides: ["read"] },
  DATAFORSEO_GET_KW_BING_KW_SUGGESTIONS_FOR_URL_LIVE: { stableName: 'bing_keywords_for_url', categoryOverrides: ["read"] },
  DATAFORSEO_GET_BACKLINKS_SUMMARY_LIVE: { stableName: 'backlinks_summary', categoryOverrides: ["read"] },
  DATAFORSEO_GET_BACKLINKS_BULK_PAGES_SUMMARY_LIVE: { stableName: 'backlinks_bulk_summary', categoryOverrides: ["read"] },
  DATAFORSEO_GET_BACKLINKS_BULK_SPAM_SCORE_LIVE: { stableName: 'backlinks_spam_score', categoryOverrides: ["read"] },
  DATAFORSEO_GET_GOOGLE_HIST_BULK_TRAFFIC_EST_LIVE: { stableName: 'traffic_estimate', categoryOverrides: ["read"] },
  DATAFORSEO_GET_DOMAIN_ANALYTICS_TECH_TECHNOLOGY_STATS_LIVE: { stableName: 'technology_stats', categoryOverrides: ["read"] },
  DATAFORSEO_GET_SERP_GOOGLE_ADS_SEARCH_LIVE_ADVANCED: { stableName: 'serp_google_ads', categoryOverrides: ["read"] },
  DATAFORSEO_GET_SERP_GOOGLE_ADS_ADVERTISERS_LIVE_ADVANCED: { stableName: 'serp_google_advertisers', categoryOverrides: ["read"] },
  DATAFORSEO_GET_AI_OPTIMIZATION_LLM_MENTIONS_TOP_DOMAINS_LIVE: { stableName: 'llm_mentions_top_domains', categoryOverrides: ["read"] },
  DATAFORSEO_GET_AI_OPTIMIZATION_CHAT_GPT_LLM_RESPONSES_LIVE: { stableName: 'llm_responses', categoryOverrides: ["read"] },
  DATAFORSEO_CREATE_SERP_GOOGLE_ORGANIC_TASK_POST: { stableName: 'start_serp_task', categoryOverrides: ["write"] },
  DATAFORSEO_LIST_SERP_GOOGLE_ORGANIC_TASKS_READY: { stableName: 'list_serp_tasks_ready', categoryOverrides: ["read"] },
  DATAFORSEO_GET_SERP_GOOGLE_ORGANIC_TASK_REGULAR_BY_ID: { stableName: 'get_serp_task', categoryOverrides: ["read"] },
  DATAFORSEO_GET_SERP_GOOGLE_ORGANIC_TASK_ADVANCED_BY_ID: { stableName: 'get_serp_task_advanced', categoryOverrides: ["read"] },
  DATAFORSEO_CREATE_KW_GOOGLE_KW_FOR_KW_TASK: { stableName: 'start_keyword_task', categoryOverrides: ["write"] },
  DATAFORSEO_GET_KW_GOOGLE_KW_FOR_KW_TASK_BY_ID: { stableName: 'get_keyword_task', categoryOverrides: ["read"] },
  DATAFORSEO_CREATE_KEYWORDS_DATA_GOOGLE_TRENDS_EXPLORE_TASK: { stableName: 'start_trends_task', categoryOverrides: ["write"] },
  DATAFORSEO_GET_KW_GOOGLE_TRENDS_EXPLORE_TASK_BY_ID: { stableName: 'get_trends_task', categoryOverrides: ["read"] },
  DATAFORSEO_CREATE_ON_PAGE_TASK_POST: { stableName: 'start_site_audit', categoryOverrides: ["write"] },
  DATAFORSEO_LIST_ON_PAGE_TASKS_READY: { stableName: 'list_site_audits_ready', categoryOverrides: ["read"] },
  DATAFORSEO_GET_ON_PAGE_SUMMARY_BY_ID: { stableName: 'get_site_audit_summary', categoryOverrides: ["read"] },
  DATAFORSEO_GET_ON_PAGE_PAGES: { stableName: 'get_site_audit_pages', categoryOverrides: ["read"] },
  DATAFORSEO_GET_ON_PAGE_DUPLICATE_TAGS: { stableName: 'get_site_audit_duplicate_tags', categoryOverrides: ["read"] },
  DATAFORSEO_GET_ON_PAGE_NON_INDEXABLE: { stableName: 'get_site_audit_non_indexable', categoryOverrides: ["read"] },
  DATAFORSEO_GET_ON_PAGE_LINKS: { stableName: 'get_site_audit_links', categoryOverrides: ["read"] },
  DATAFORSEO_CREATE_ON_PAGE_LIGHTHOUSE_TASK_POST: { stableName: 'start_lighthouse_audit', categoryOverrides: ["write"] },
  DATAFORSEO_GET_ON_PAGE_LIGHTHOUSE_TASK_GET_JSON: { stableName: 'get_lighthouse_audit', categoryOverrides: ["read"] },
};

export const DATAFORSEO_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
