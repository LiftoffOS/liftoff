// Capability tri-state, enforced at the gateway.
//
// "Your Slack is down" and "this business has no chat tool and never will" are
// different facts, and an agent that cannot tell them apart promises to retry
// the second. Two states could not express the difference, so `absent` exists:
//
//   live     bound and usable
//   unwired  the platform supports it, this tenant has not connected it — so
//            prose may promise it conditionally, and wiring it later changes no
//            prompt bytes
//   absent   the platform cannot do it AT ALL. Not an outage. Not "later".
//
// REFUSED BY NAME, NOT MERELY HIDDEN, and the distinction is the whole point of
// enforcing it here rather than only filtering the catalog.
//
// Hiding is what the tool surface already does, and hiding alone fails in a
// specific and observed way: a model that has been told in prose what it can do
// reaches for a tool it cannot see, gets "unknown tool", and treats that as a
// transient fault — so it retries, or it invents a neighbouring tool that IS
// present and uses it wrongly. "Unknown tool" is indistinguishable from a
// catalog that has not loaded.
//
// A refusal that NAMES the capability and says it does not exist is a different
// signal entirely: it is terminal, it is explainable to the person, and it
// gives the model the one correct move — say so, and stop.

import { logger } from '../infrastructure/logging';

export type CapabilityState = 'live' | 'unwired' | 'absent';

export interface TriStateRefusal {
  refused: true;
  capability: string;
  message: string;
}

/**
 * Whether this tool belongs to a capability the business does not have.
 *
 * Resolution is by CAPABILITY rather than by tool name, because that is the
 * unit a person decides about: "we have no chat tool" is a fact about the
 * business, and it must not have to be restated for every tool a chat connector
 * happens to expose.
 */
export function refusalForTool(args: {
  toolName: string;
  /** Which capability each bound tool serves. */
  capabilityForTool: (toolName: string) => string | null;
  capabilityStates: Record<string, CapabilityState> | undefined;
}): TriStateRefusal | null {
  const states = args.capabilityStates ?? {};
  if (Object.keys(states).length === 0) return null;

  const capability = args.capabilityForTool(args.toolName);
  if (!capability) return null;
  if (states[capability] !== 'absent') return null;

  return {
    refused: true,
    capability,
    message: buildRefusalMessage(capability, args.toolName),
  };
}

/**
 * What the model is told.
 *
 * Says three things, and each is there because its absence produced a specific
 * wrong behaviour: WHICH capability (so the answer to the person can name it),
 * that it is NOT an outage (so the model does not offer to try later), and what
 * to do instead (so it stops rather than reaching for a neighbouring tool).
 *
 * Deliberately not phrased as an error. It is a fact about the workspace, and a
 * model handed an error looks for a way around it.
 */
function buildRefusalMessage(capability: string, toolName: string): string {
  return [
    `This workspace has no ${capability.replace(/_/g, ' ')} capability, so ${toolName} cannot run.`,
    'This is not an outage and it will not become available later: there is no such tool here.',
    'Do not retry, and do not substitute a different tool.',
    'Say plainly what you could not do and continue with the rest of the work.',
  ].join(' ');
}

/** Emit the metric. A refusal is worth counting: a rising rate means prose is
 *  promising something the workspace cannot do, which is a distillation defect
 *  rather than a runtime one. */
export function reportTriStateRefusal(args: {
  refusal: TriStateRefusal;
  toolName: string;
  tenantId: string;
  agentId: string;
  invocationId?: string;
}): void {
  logger.warn({
    event: 'capability_absent_refusal',
    metric: 'capability.absent_refusal',
    capability: args.refusal.capability,
    toolName: args.toolName,
    tenantId: args.tenantId,
    agentId: args.agentId,
    invocationId: args.invocationId,
  }, 'refused a tool whose capability this workspace does not have');
}
