// Well-known internal_agents rows — real backend rows (platform-backend
// migration 194) never fetched or listed by the frontend, referenced only by
// a hardcoded id. Every generic /api/agent-chat/:agentId/* endpoint already
// works against any of these ids with zero backend changes.

/** The Chief AI Officer. Shared by every workspace. */
export const CAIO_AGENT_ID = '00000000-0000-0000-0000-000000000001'

// There is deliberately no id here for Liftoff, the general-purpose assistant
// behind the home composer. It is a platform assistant rather than one of the
// workspace's agents, so it follows the Insights Manager's shape: its own
// /api/liftoff endpoints, with no agent id in any URL. See services/liftoffChat.
//
// The id that used to live here, ...0002, is the HR Business Partner (backend
// migration 194), which is why every call from the Liftoff page 404'd: system
// agents carry tenant_id NULL and agent-chat admission matches on tenant_id.
