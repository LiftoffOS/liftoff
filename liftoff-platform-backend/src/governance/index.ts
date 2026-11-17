// Governance Module — thin barrel for the Phase 3 cutover.
//
// All /api/governance/* HTTP traffic is forwarded to governance-engine via
// the proxy router. Dashboard flows (approvals, action ledger, usage ledger,
// audit, late-feedback) go through this proxy so platform-backend owns the
// edge authentication (Firebase) while service-to-service auth (OIDC +
// X-Service-Auth) is attached per-hop.

export { governanceProxyRouter, createGovernanceProxyRouter } from './proxy';
