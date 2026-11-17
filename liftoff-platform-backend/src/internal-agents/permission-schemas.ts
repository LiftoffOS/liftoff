// Zod schemas for IntegrationPermission validation.
//
// Extracted from router.ts so they can be imported by tests, the distill
// merge step, and any other writer that needs to validate a permission
// shape — without pulling in the full router → service → tenant-runtime
// client transitive graph.

import { z } from 'zod';

// Per-binding Gmail config schema. Validated by the IntegrationPermission
// superRefine when the permission's config keys look gmail-shaped (the outer
// `type` field is enriched downstream and may be absent on raw create
// requests).
export const gmailBindingConfigSchema = z
  .object({
    gmailQuery: z.string().max(500).optional(),
    sendAs: z.string().email().max(255).optional(),
  })
  .strict();

// Per-binding Microsoft Outlook Mail config schema. Validated by the
// IntegrationPermission superRefine when the config keys look outlook-shaped.
export const outlookBindingConfigSchema = z
  .object({
    outlookFilter: z.string().max(1000).optional(),
    sendAs: z.string().email().max(255).optional(),
  })
  .strict();

// Integration permission schema - defines object-level access.
export const integrationPermissionSchema = z
  .object({
    id: z.string().min(1).max(255),
    integrationId: z.string().min(1).max(255).optional(),
    selectedObjects: z.array(z.string().max(255)).max(100).default([]),
    collaborationMode: z
      .enum(['request_help', 'receive_delegated', 'two_way', 'observe_only'])
      .optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((val, ctx) => {
    if (!val.config) return;
    const cfg = val.config as Record<string, unknown>;

    const looksGmail = 'gmailQuery' in cfg;
    const looksOutlook = 'outlookFilter' in cfg;

    if (looksGmail && looksOutlook) {
      ctx.addIssue({
        code: 'custom',
        path: ['config'],
        message: 'config cannot mix gmail and outlook fields',
      });
      return;
    }

    if (looksGmail) {
      const r = gmailBindingConfigSchema.safeParse(cfg);
      if (!r.success) {
        r.error.issues.forEach((i) => ctx.addIssue({ ...i, path: ['config', ...i.path] }));
      }
      return;
    }

    if (looksOutlook) {
      const r = outlookBindingConfigSchema.safeParse(cfg);
      if (!r.success) {
        r.error.issues.forEach((i) => ctx.addIssue({ ...i, path: ['config', ...i.path] }));
      }
      return;
    }

    // Lone `sendAs` (no provider-specific key): pre-enrichment validation can
    // only check the shape, not which provider it belongs to.
    if ('sendAs' in cfg) {
      const r = z.object({ sendAs: z.string().email() }).strict().safeParse(cfg);
      if (!r.success) {
        r.error.issues.forEach((i) => ctx.addIssue({ ...i, path: ['config', ...i.path] }));
      }
    }
  });
