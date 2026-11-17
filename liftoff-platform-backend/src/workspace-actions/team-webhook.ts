// A team's inbound webhook, for the assistants: its settings (never its URL
// or secret — those are the page's, D5), a settings change, and its recent
// deliveries. Provisioning and a secret reset are not wrapped: both mint a
// secret, which never goes through a conversation.

import { z } from 'zod';
import {
  getSourceForAgent,
  listRecentDeliveries,
  updateSource,
  type DeliverySummary,
  type EventSource,
} from '../event-sources/service';
import { requirePermission, type Actor } from './actor';
import { writeAudit } from './audit';

export const webhookPatchSchema = z.object({
  enabled: z.boolean().optional(),
  hmacRequired: z.boolean().optional(),
  rateLimitPerMinute: z.number().int().min(1).max(10000).optional(),
  contentFilterEnabled: z.boolean().optional(),
  piiHashMode: z.boolean().optional(),
});
export type WebhookPatch = z.infer<typeof webhookPatchSchema>;

export interface WebhookSettings {
  enabled: boolean;
  hmacRequired: boolean;
  secretHint: string;
  rateLimitPerMinute: number;
  contentFilterEnabled: boolean;
  piiHashMode: boolean;
  lastEventAt: string | null;
}

/** The page's publicMetadata minus the URL: a chat result must not carry the
 *  inbound address, which is as good as a credential. */
function settingsOf(source: EventSource): WebhookSettings {
  return {
    enabled: source.enabled,
    hmacRequired: source.hmacRequired,
    secretHint: source.signingSecretHint,
    rateLimitPerMinute: source.rateLimitPerMinute,
    contentFilterEnabled: source.contentFilterEnabled,
    piiHashMode: source.piiHashMode,
    lastEventAt: source.lastEventAt,
  };
}

export async function getWebhook(actor: Actor, agentId: string): Promise<{ webhook: WebhookSettings } | { refused: 'not_provisioned'; message: string }> {
  const source = await getSourceForAgent(actor.tenantId, agentId);
  if (!source) return { refused: 'not_provisioned', message: 'This team has no inbound webhook yet. It is provisioned from the team\'s Settings page.' };
  return { webhook: settingsOf(source) };
}

export async function setWebhook(actor: Actor, agentId: string, patch: WebhookPatch): Promise<{ webhook: WebhookSettings } | { refused: 'not_provisioned'; message: string }> {
  requirePermission(actor, 'teams:update');
  const source = await getSourceForAgent(actor.tenantId, agentId);
  if (!source) return { refused: 'not_provisioned', message: 'This team has no inbound webhook yet. It is provisioned from the team\'s Settings page.' };
  const updated = await updateSource({ tenantId: actor.tenantId, sourceId: source.id, patch, actorUserId: actor.accountId });
  if (!updated) return { refused: 'not_provisioned', message: 'This team has no inbound webhook yet.' };
  writeAudit(actor, 'internal_agent.webhook_settings_updated', { internalAgentId: agentId, sourceId: source.id, patch });
  return { webhook: settingsOf(updated) };
}

export async function webhookDeliveries(actor: Actor, agentId: string, limit = 5): Promise<{ deliveries: DeliverySummary[] } | { refused: 'not_provisioned'; message: string }> {
  const source = await getSourceForAgent(actor.tenantId, agentId);
  if (!source) return { refused: 'not_provisioned', message: 'This team has no inbound webhook yet.' };
  return { deliveries: await listRecentDeliveries(actor.tenantId, source.id, limit) };
}
