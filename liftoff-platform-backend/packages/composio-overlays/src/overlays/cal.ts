// cal overlay. Stable names + categories over the REAL Composio tools.
// translateInput/Output left passthrough; normalize by hand from each tool's
// output_parameters if/when needed — never guess a field.

import type { ComposioToolOverlay, HistoryToolMapping } from '../types';

export const CAL_OVERLAYS: Record<string, ComposioToolOverlay> = {
  CAL_FETCH_ALL_BOOKINGS: { stableName: 'list_bookings', categoryOverrides: ["read"] },
  CAL_RETRIEVE_BOOKING_DETAILS_BY_UID: { stableName: 'get_booking', categoryOverrides: ["read"] },
  CAL_POST_NEW_BOOKING_REQUEST: { stableName: 'create_booking', categoryOverrides: ["write"] },
  CAL_RESCHEDULE_BOOKING_BY_UID: { stableName: 'reschedule_booking', categoryOverrides: ["write"] },
  CAL_CANCEL_BOOKING_VIA_UID: { stableName: 'cancel_booking', categoryOverrides: ["write"] },
  CAL_CONFIRM_BOOKING_BY_UID: { stableName: 'confirm_booking', categoryOverrides: ["read"] },
  CAL_DECLINE_BOOKING_WITH_REASON: { stableName: 'decline_booking', categoryOverrides: ["write","destructive"] },
  CAL_LIST_EVENT_TYPES: { stableName: 'list_event_types', categoryOverrides: ["read"] },
  CAL_FETCH_EVENT_TYPE_DETAILS: { stableName: 'get_event_type', categoryOverrides: ["read"] },
  CAL_GET_AVAILABLE_SLOTS_INFO: { stableName: 'get_available_slots', categoryOverrides: ["read"] },
  CAL_RESERVE_SLOT_FOR_EVENT: { stableName: 'reserve_slot', categoryOverrides: ["read"] },
  CAL_GET_DEFAULT_SCHEDULE_DETAILS: { stableName: 'get_default_schedule', categoryOverrides: ["read"] },
};

export const CAL_HISTORY_MAPPINGS: HistoryToolMapping[] = [];
