// Workforce Plans — thin proxy module (Phase 4: cutover complete).
// All /api/workforce-plans/* and /api/team-plan/* traffic is forwarded
// unconditionally to liftoff-workforce-service.

export { createWorkforceProxyRouter } from './workforce-proxy';
