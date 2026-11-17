// reddit_ads overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.
//
// Provenance is stated in canonical shape, which for a passthrough overlay IS
// Composio's: the Reddit Ads API wraps every body in `data` (an array for a
// list, an object for a get/create), so ids live at `data[].id` / `data.id`,
// and the id arguments are the ones the input schema names.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const REDDIT_ADS_OVERLAYS: Record<string, ComposioToolOverlay> = {
  REDDIT_ADS_GET_ME: { stableName: 'get_me', categoryOverrides: ["read"] },
  REDDIT_ADS_LIST_MY_BUSINESSES: { stableName: 'list_businesses', categoryOverrides: ["read"] },
  REDDIT_ADS_LIST_AD_ACCOUNTS_BY_BUSINESS: { stableName: 'list_ad_accounts', categoryOverrides: ["read"] },
  REDDIT_ADS_GET_AD_ACCOUNT: { stableName: 'get_ad_account', categoryOverrides: ["read"] },
  REDDIT_ADS_LIST_FUNDING_INSTRUMENTS: { stableName: 'list_funding_instruments', categoryOverrides: ["read"] },
  REDDIT_ADS_LIST_CAMPAIGNS: {
    stableName: 'list_campaigns',
    categoryOverrides: ['read'],
    returnsIds: [{ entityType: 'campaign', path: 'data[].id' }],
  },
  REDDIT_ADS_GET_CAMPAIGN: {
    stableName: 'get_campaign',
    categoryOverrides: ['read'],
    returnsIds: [{ entityType: 'campaign', path: 'data.id' }],
  },
  REDDIT_ADS_LIST_AD_GROUPS: { stableName: 'list_ad_groups', categoryOverrides: ["read"] },
  REDDIT_ADS_GET_AD_GROUP: { stableName: 'get_ad_group', categoryOverrides: ["read"] },
  REDDIT_ADS_LIST_ADS: { stableName: 'list_ads', categoryOverrides: ["read"] },
  REDDIT_ADS_GET_A_REPORT: { stableName: 'get_report', categoryOverrides: ["read"] },
  REDDIT_ADS_GET_AD_ACCOUNT_HISTORY: { stableName: 'get_account_history', categoryOverrides: ["read"] },
  REDDIT_ADS_LIST_SAVED_AUDIENCES: {
    stableName: 'list_saved_audiences',
    categoryOverrides: ['read'],
    returnsIds: [{ entityType: 'saved_audience', path: 'data[].id' }],
  },
  REDDIT_ADS_GET_SAVED_AUDIENCE: { stableName: 'get_saved_audience', categoryOverrides: ["read"] },
  REDDIT_ADS_LIST_USER_CUSTOM_AUDIENCES: { stableName: 'list_custom_audiences', categoryOverrides: ["read"] },
  REDDIT_ADS_LIST_LEAD_GEN_FORMS: { stableName: 'list_lead_gen_forms', categoryOverrides: ["read"] },
  REDDIT_ADS_SEARCH_COMMUNITIES: { stableName: 'search_communities', categoryOverrides: ["read"] },
  REDDIT_ADS_LIST_INTERESTS: { stableName: 'list_interests', categoryOverrides: ["read"] },
  REDDIT_ADS_GET_CHANNEL_PLANNING_REACH: { stableName: 'estimate_reach', categoryOverrides: ["read"] },
  REDDIT_ADS_DO_KEYWORD_VALIDATIONS: { stableName: 'validate_keywords', categoryOverrides: ["read"] },
  REDDIT_ADS_LIST_POSTS: { stableName: 'list_posts', categoryOverrides: ["read"] },
  REDDIT_ADS_GET_POST: { stableName: 'get_post', categoryOverrides: ["read"] },
  REDDIT_ADS_CREATE_CAMPAIGN: {
    stableName: 'create_campaign',
    categoryOverrides: ['write'],
    returnsIds: [{ entityType: 'campaign', path: 'data.id' }],
  },
  REDDIT_ADS_UPDATE_CAMPAIGN: { stableName: 'update_campaign', categoryOverrides: ['write'], idArgs: ['campaign_id'] },
  // The campaign an ad group is created in is named INSIDE the `data` body
  // (`data.campaign_id`), and idArgs are read from the top-level arguments only,
  // so a declaration here would name an argument the tool does not take.
  REDDIT_ADS_CREATE_AD_GROUP: { stableName: 'create_ad_group', categoryOverrides: ['write'] },
  REDDIT_ADS_CREATE_SAVED_AUDIENCE: {
    stableName: 'create_saved_audience',
    categoryOverrides: ['write'],
    returnsIds: [{ entityType: 'saved_audience', path: 'data.id' }],
  },
  REDDIT_ADS_UPDATE_SAVED_AUDIENCE: { stableName: 'update_saved_audience', categoryOverrides: ['write'], idArgs: ['saved_audience_id'] },
  REDDIT_ADS_CREATE_POST: { stableName: 'create_post', categoryOverrides: ["write","outbound"] },
};

export const REDDIT_ADS_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
