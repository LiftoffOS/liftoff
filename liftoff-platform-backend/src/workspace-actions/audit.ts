// Every workspace action lands in the audit log under the person who took it
// and where they took it from.
//
// `userId` is the account UUID, which is what audit_log.user_id holds and what
// validateUuid in infrastructure/logging keeps; the dashboard's team routes
// used to pass the request context's Firebase uid there and every such row
// carried a NULL user. `operation` names the surface. The origin fields
// (surface, via, client, credentialId) go into the metadata so the workspace
// feed can say "from Claude Code through Liftoff" rather than only "Liftoff".

import { logAudit } from '../infrastructure/logging';
import type { Actor } from './actor';

export function writeAudit(actor: Actor, action: string, details: Record<string, unknown> = {}): void {
  logAudit(
    action,
    { tenantId: actor.tenantId, userId: actor.accountId, operation: actor.surface },
    {
      ...details,
      surface: actor.surface,
      ...(actor.via ? { via: actor.via } : {}),
      ...(actor.client ? { client: actor.client } : {}),
      ...(actor.credentialId ? { credentialId: actor.credentialId } : {}),
    },
  );
}
