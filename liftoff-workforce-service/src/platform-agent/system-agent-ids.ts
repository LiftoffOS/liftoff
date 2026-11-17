// Shared constants for the two platform-owned (is_system=TRUE) agents.
//
// These UUIDs come from migrations 193/194 in platform-backend. Any code that
// references them must import from here — duplicate string literals in this
// repo have caused subtle drift before (e.g. one path pointed at the HRBP id
// while another pointed at CAIO).

export const CAIO_AGENT_ID = '00000000-0000-0000-0000-000000000001';
export const HRBP_AGENT_ID = '00000000-0000-0000-0000-000000000002';
