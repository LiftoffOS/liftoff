// mailchimp overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const MAILCHIMP_OVERLAYS: Record<string, ComposioToolOverlay> = {
  MAILCHIMP_GET_LISTS_INFO: { stableName: 'list_audiences', categoryOverrides: ["read"] },
  MAILCHIMP_GET_LIST_INFO: { stableName: 'get_audience', categoryOverrides: ["read"] },
  MAILCHIMP_LIST_CAMPAIGNS: { stableName: 'list_campaigns', categoryOverrides: ["read"] },
  MAILCHIMP_LIST_MEMBERS_INFO: { stableName: 'list_members', categoryOverrides: ["read"] },
  MAILCHIMP_SEARCH_MEMBERS: { stableName: 'search_members', categoryOverrides: ["read"] },
  // The first staged-write pair (ADR-052 rule 5): a campaign is DRAFTED by
  // create_campaign — Mailchimp holds it unsent, a customer sees nothing — and
  // COMMITTED by send_campaign, which is one vendor call the vendor sends whole
  // or not at all. One approval covers the whole send; the runtime records
  // the draft as a staged batch, binds the person's yes to it by digest, and
  // lets send_campaign apply it exactly once (tenant-runtime
  // tool-gateway/staged-batches.ts). Declared as a pair or not at all; the
  // registry validates the pairing at boot.
  MAILCHIMP_ADD_CAMPAIGN: { stableName: 'create_campaign', categoryOverrides: ["write"], writeRole: 'stage', paired_apply: 'send_campaign' },
  MAILCHIMP_SEND_CAMPAIGN: { stableName: 'send_campaign', categoryOverrides: ["write","outbound"], writeRole: 'apply' },
  MAILCHIMP_ADD_MEMBER_TO_LIST: { stableName: 'add_member_to_list', categoryOverrides: ["write"] },
  MAILCHIMP_ADD_OR_UPDATE_LIST_MEMBER: { stableName: 'upsert_member', categoryOverrides: ["write"] },
  MAILCHIMP_ADD_MEMBER_NOTE: { stableName: 'add_member_note', categoryOverrides: ["write"] },
  MAILCHIMP_ADD_OR_REMOVE_MEMBER_TAGS: { stableName: 'update_member_tags', categoryOverrides: ["write"] },
  MAILCHIMP_ADD_LIST: { stableName: 'create_audience', categoryOverrides: ["write"] },
};

export const MAILCHIMP_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
