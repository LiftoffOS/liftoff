// HRBP tool-context type — narrowing of runPlatformAgent's
// generic Record<string, unknown> toolContext.

import type { WorkforcePlanAgentSpec } from '../../workforce-plans/types.js';

export interface HrbpToolContext {
  tenantId: string;
  planId: string;
  /** Foreign key target for hrbp_provisioning_events and hrbp_compensation_log.
   *  Created by the workforce-plan approve handler before fan-out and carried
   *  through the Cloud Tasks payload. */
  runId: string;
  specId: string;
  approverAccountId: string;
  /** Set by teambuilder__create after successful create. Other tools (e.g.
   *  compensate) reference it. */
  createdInternalAgentId?: string;
  /** The full distill response, stashed by teambuilder__distill and merged into
   *  the create body by teambuilder__create.
   *
   *  Distilled output is data, and data does not survive a round trip through a
   *  model that has to copy it by hand: it can only carry the fields the next
   *  tool's schema names, and drops the rest without saying so. */
  distillResult?: Record<string, unknown>;
  /** The spec being provisioned this run. Made available so tools can read
   *  spec fields without re-fetching from the workforce_plans row. */
  spec: WorkforcePlanAgentSpec;
}
