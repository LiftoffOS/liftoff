// Capability discovery + execution for the out-of-process platform agents —
// the Chief AI Officer (workforce-service) and distilled agents (tenant-
// runtime) — which cannot call the in-process capability tools the Liftoff
// assistant uses.
//
// CAPABILITY-FIRST, like the assistant. The search response is the same
// vendor-hidden, handle-bearing rendering (reused straight from
// liftoff/capability-tools), and POST /run executes one capability by its
// opaque handle. The vendor never crosses this boundary either, so an agent or
// the CAIO absorbing this into a standing agent cannot leak it. Handles are
// stateless tokens (capability-discovery/handles), so a search on one instance
// and the run on another still resolve.
//
// Auth: any internal service token its two consumers hold — WORKFORCE (CAIO)
// or TENANT_RUNTIME (agents) — via X-Service-Auth, timing-safe. Mounted BEFORE
// authMiddleware (the caller is a service, not a person; the body carries the
// tenant context the caller already holds).

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { log } from '../infrastructure/logging';
import { runCapabilitySearch, runCapabilityDiscovery, runCapability } from '../liftoff/capability-tools';
import { DATASET_TOOL_NAMES, runDatasetTool } from '../datasets/tools';
import type { DatasetScope } from '../datasets/store';
// One implementation of the token comparison, shared with the parking route
// mounted beside this one (capability-service-auth.ts).
import { capabilityServiceAuth, type CapabilityCaller } from './capability-service-auth';

export const capabilityDiscoveryInternalRouter = Router();

capabilityDiscoveryInternalRouter.use(capabilityServiceAuth);

const searchSchema = z.object({
  tenantId: z.string().min(1),
  // Optional: the account of the person behind the search, when a person
  // drove the turn, so the vendors are judged on the credentials their run
  // would use (a workspace connector of the vendor's type when connected,
  // else the platform key). Absent for an autonomous run, which executes on
  // the platform credential and is judged on it. Supplied by the calling
  // service from its own context — never read from a model's arguments.
  accountId: z.string().min(1).optional(),
  targetSystem: z.string().min(1).max(64).optional(),
  operation: z.string().min(1).max(120),
  entity: z.string().min(1).max(120),
  mode: z.enum(['own_account', 'public_data']),
  availableInputs: z.array(z.string().min(1).max(120)).max(20).optional(),
  requiredOutputFields: z.array(z.string().min(1).max(120)).max(20).optional(),
  // Calibration/introspection: return the STRUCTURED ranked candidates (scores,
  // judge verdicts, health stats, every factor) instead of the model-facing
  // rendered string. Service-authed and operator-only — the model-facing tools
  // never set it — so it may carry vendor identity. It runs discovery only (no
  // vendor execution), which is what lets the weak-fit threshold and health
  // floors be calibrated against an intent corpus before any real traffic.
  debug: z.boolean().optional(),
});

capabilityDiscoveryInternalRouter.post('/', async (req: Request, res: Response) => {
  const parsed = searchSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
  }
  try {
    const { tenantId, accountId, debug, ...spec } = parsed.data;
    if (debug === true) {
      const discovery = await runCapabilityDiscovery(tenantId, spec);
      return res.json({ discovery });
    }
    const result = await runCapabilitySearch(tenantId, spec, accountId);
    return res.json({ result });
  } catch (error) {
    log.error({ error }, 'internal capability search failed');
    return res.status(500).json({ error: 'discovery failed' });
  }
});

const SCOPE_KIND = z.enum(['liftoff_thread', 'insights_thread', 'caio_thread', 'agent_run']);

/** The job a caller names, or none: a result parked unscoped is readable
 *  by id and listed by nobody. */
function scopeOf(kind: z.infer<typeof SCOPE_KIND> | undefined, id: string | undefined): DatasetScope {
  return kind && id ? { kind, id } : { kind: 'unscoped', id: '' };
}

const runSchema = z.object({
  tenantId: z.string().min(1),
  // Optional: present when a person drove the turn (enables the tenant's own
  // connected-vendor key); absent for an autonomous agent run, which runs
  // platform-funded. Empty resolves to the platform path in the executor.
  accountId: z.string().min(1).optional(),
  capabilityId: z.string().min(1),
  args: z.record(z.unknown()).default({}),
  /** The job the call belongs to — a run, a conversation — which is where a
   *  large result is parked as a dataset, and what dataset_list lists. */
  scopeKind: SCOPE_KIND.optional(),
  scopeId: z.string().min(1).max(200).optional(),
  /** A dataset of the same job to add this run's records to. */
  appendTo: z.string().regex(/^[0-9a-f-]{36}$/i).optional(),
  /** The same arguments under the name a model sometimes uses, as an object or
   *  a JSON-encoded string. Read by runCapability when `args` is empty. */
  arguments: z.union([z.record(z.unknown()), z.string()]).optional(),
  // Set true by the tenant-runtime ONLY after a human approved this exact call
  // at its admission gate. It is the sole key that lets a write/outbound-class
  // capability execute, and only for the agent caller — platform-backend still
  // re-derives the true class from classification, so this cannot force an
  // unapproved write. Ignored for the CAIO caller (no approval flow).
  approved: z.boolean().optional(),
  /** The runtime's identity for this act, forwarded to the connector boundary
   *  so a repeat is replayed rather than re-executed. Bounded and character-
   *  restricted: it becomes a key in another service. */
  idempotencyKey: z.string().regex(/^[A-Za-z0-9:._-]{1,200}$/).optional(),
  /** `internal_agents.id` of the agent this run belongs to. The cost row is
   *  otherwise booked with no agent and no surface, and the Cost Breakdown has
   *  nowhere to put it, so the spend is reported as "Unattributed".
   *
   *  Named `internalAgentId` because that is what the tenant runtime emits on
   *  anything sent to the control plane (INV-TR-010) — the two id spaces are
   *  disjoint and the name is what says which one this is. The runtime
   *  translates before sending and omits the field when its mapping misses, so
   *  a value here is always control-plane space. */
  internalAgentId: z.string().uuid().optional(),
});

capabilityDiscoveryInternalRouter.post('/run', async (req: Request & { capabilityCaller?: CapabilityCaller }, res: Response) => {
  const parsed = runSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
  }
  try {
    const { tenantId, accountId, capabilityId, args, approved, idempotencyKey, scopeKind, scopeId, appendTo, internalAgentId } = parsed.data;
    const caller = req.capabilityCaller ?? 'agent';
    // Approval is honoured only for the agent caller: it is the one with a
    // human-in-the-loop admission gate. A stray approved flag from any other
    // caller is dropped here rather than trusted.
    const outcome = await runCapability(tenantId, accountId ?? '', { capabilityId, args, arguments: parsed.data.arguments, appendTo }, {
      caller,
      // Honoured only for the agent caller, like `approved`: an assistant has
      // no agent id, so one arriving on an assistant call is a mistake or a
      // spoof and is dropped rather than trusted.
      ...(caller === 'agent' && internalAgentId ? { agentId: internalAgentId } : {}),
      approved: caller === 'agent' ? approved === true : false,
      idempotencyKey,
      scope: scopeOf(scopeKind, scopeId),
    });
    // `result` is the model-facing text, unchanged in shape for older callers;
    // `outcome` is the status, so a caller can tell a run that happened from a
    // refusal rendered as text — and, on a run that happened, whether it
    // ANSWERED: `empty` is true when the source ran and returned nothing
    // usable, which a caller counting useful results must not count. A
    // `handoff` names, in the text, the next candidate for the same need and
    // a fresh handle for it. The reason stays in this service's logs.
    return res.json({
      result: outcome.text,
      outcome: outcome.ok ? { ok: true, empty: outcome.empty } : { ok: false, kind: outcome.kind },
    });
  } catch (error) {
    log.error({ error }, 'internal capability run failed');
    return res.status(500).json({ error: 'run failed' });
  }
});

// The dataset tools, for the same two callers: a query, an extraction, or
// the list of a job's datasets, answered as the model-facing text the
// in-process assistant gets. An extraction's model calls are attributed to
// the tenant under the caller's own purpose.
const datasetToolSchema = z.object({
  tenantId: z.string().min(1),
  tool: z.enum(DATASET_TOOL_NAMES),
  input: z.record(z.unknown()).default({}),
  scopeKind: SCOPE_KIND.optional(),
  scopeId: z.string().min(1).max(200).optional(),
});

capabilityDiscoveryInternalRouter.post('/datasets/tool', async (req: Request & { capabilityCaller?: CapabilityCaller }, res: Response) => {
  const parsed = datasetToolSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten() });
  }
  try {
    const { tenantId, tool, input, scopeKind, scopeId } = parsed.data;
    const caller = req.capabilityCaller ?? 'agent';
    const result = await runDatasetTool(tenantId, tool, input, {
      scope: scopeOf(scopeKind, scopeId),
      purpose: caller === 'caio' ? 'caio_dataset_extract' : 'agent_dataset_extract',
    });
    return res.json({ result });
  } catch (error) {
    log.error({ error }, 'internal dataset tool failed');
    return res.status(500).json({ error: 'dataset tool failed' });
  }
});
