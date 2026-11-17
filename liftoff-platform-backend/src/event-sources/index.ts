// Custom Event Sources — per-agent inbound webhooks.
//
// Frontend → POST /api/internal-agents/:id/webhook (provision) → returns the
// URL and signing secret once. External systems then POST signed payloads
// to /api/events/custom/:token; the inbound router validates, audits, and
// enqueues an `event.custom_received` outbox event keyed to the matched
// trigger rule. Tenant-runtime consumes those events and invokes the
// agent executor with `trustLevel: 'untrusted_inbound'`.

export { eventSourcesInboundRouter } from './inbound-router';
export { webhookManagementRouter, webhookTenantAdminRouter } from './routes';
