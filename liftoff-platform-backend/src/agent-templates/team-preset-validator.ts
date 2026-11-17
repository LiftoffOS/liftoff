// Team presets — Zod validation.
//
// A team preset is a named bundle of agent-template roles provisioned together as a
// working team (e.g. a software delivery team = engineer + reviewer + security + sre).
// Each role references an existing catalog template by id and carries role prose whose
// trigger sentences distill into the intended reactive subscriptions at provisioning
// time (subscriptions are distill-emitted, never hand-authored here).

import { z } from 'zod';

const teamPresetRoleZodSchema = z.object({
  key: z.string().min(1).max(100),
  templateId: z.string().min(1).max(100),
  roleProse: z.string().min(1).max(20000),
  escalationRecipient: z.string().min(1).max(200).optional(),
});

export const teamPresetZodSchema = z.object({
  id: z.string().min(1).max(100),
  version: z.string().min(1).max(20),
  schemaVersion: z.literal(1),
  displayName: z.string().min(1).max(200),
  description: z.string().min(1).max(2000),
  roles: z.array(teamPresetRoleZodSchema).min(1).max(20).superRefine((roles, ctx) => {
    const seen = new Set<string>();
    for (const r of roles) {
      if (seen.has(r.key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate role key "${r.key}"`, path: [] });
      }
      seen.add(r.key);
    }
  }),
  provisioningNotes: z.string().max(4000).optional(),
});

export type TeamPresetRole = z.infer<typeof teamPresetRoleZodSchema>;
export type TeamPreset = z.infer<typeof teamPresetZodSchema>;
