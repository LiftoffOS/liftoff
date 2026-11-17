// Shared Zod fragments used across admin request schemas.
//
// Centralising the common shapes keeps the per-handler schemas terse and
// prevents accidental divergence on things like "what counts as a valid
// accountId."

import { z } from 'zod';

export const uuidString = z.string().uuid();

export const accountIdParam = z.object({ accountId: uuidString });
export const tenantIdParam = z.object({ tenantId: uuidString });

// `:id` is used by routes that don't disambiguate (DELETE /accounts/:id,
// POST /accounts/:id/reprovision). Same shape as accountIdParam.
export const idParam = z.object({ id: uuidString });

export const connectorTypeParam = z.object({
  connectorType: z.string().min(1).max(64),
});

export const workflowTypeParam = z.object({
  workflowType: z.string().min(1).max(64),
});
