// follow_up_boss overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const FOLLOW_UP_BOSS_OVERLAYS: Record<string, ComposioToolOverlay> = {
  FOLLOW_UP_BOSS_LIST_DEALS: { stableName: 'list_deals', categoryOverrides: ["read"] },
  FOLLOW_UP_BOSS_GET_DEAL: { stableName: 'get_deal', categoryOverrides: ["read"] },
  FOLLOW_UP_BOSS_CREATE_DEALS: { stableName: 'create_deal', categoryOverrides: ["write"] },
  FOLLOW_UP_BOSS_UPDATE_DEALS: { stableName: 'update_deal', categoryOverrides: ["write"] },
  FOLLOW_UP_BOSS_LIST_CALLS: { stableName: 'list_calls', categoryOverrides: ["read"] },
  FOLLOW_UP_BOSS_GET_CALL: { stableName: 'get_call', categoryOverrides: ["read"] },
  FOLLOW_UP_BOSS_CREATE_CALL: { stableName: 'log_call', categoryOverrides: ["write"] },
  FOLLOW_UP_BOSS_LIST_TEXT_MESSAGES: { stableName: 'list_text_messages', categoryOverrides: ["read"] },
  FOLLOW_UP_BOSS_GET_TEXT_MESSAGE: { stableName: 'get_text_message', categoryOverrides: ["read"] },
  FOLLOW_UP_BOSS_LIST_APPOINTMENTS: { stableName: 'list_appointments', categoryOverrides: ["read"] },
  FOLLOW_UP_BOSS_CREATE_APPOINTMENT: { stableName: 'create_appointment', categoryOverrides: ["write"] },
  FOLLOW_UP_BOSS_LIST_ACTION_PLANS_PEOPLE: { stableName: 'list_people_action_plans', categoryOverrides: ["read"] },
  FOLLOW_UP_BOSS_CREATE_ACTION_PLANS_PEOPLE: { stableName: 'apply_action_plan', categoryOverrides: ["write"] },
};

export const FOLLOW_UP_BOSS_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
