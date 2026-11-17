import { Router } from 'express';
import { requireSandboxJwt, type RequestWithClaims } from './middleware/sandbox-jwt-auth';
import { getPoolForService } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { buildBindingsByType } from '../tool-gateway/binding-resolver';
import { buildToolsForAgent } from '../tool-gateway/tools-builder';
import { normalizeIntegrationsField } from '../instruction-compiler/integration-shape';
import { insertAuditLog } from '../audit/service';
import { toolGatewayService } from '../tool-gateway/router';
import { hitlEnforcementService } from '../hitl-enforcement/service';
import { instructionsContractOf } from '../hitl-enforcement/contract-check';
import { checkMessage } from '../tool-gateway/message-check';
import { oversightDecisionFor } from '../tool-gateway/oversight-decision';
import { getToolSchema, getCustomApiToolSchema, CUSTOM_API_CONNECTOR_TYPE } from '../connectors/tool-schema-cache';
import { connectorManifestRepository } from '../connectors/manifest-repository';
import { deriveAllowedConnectors } from '../interactive-chat/connector-utils';
import { AdmissionService } from '../admission/service';
import { AdmissionDeniedError, ADMISSION_DENIED_CODE } from '../admission/types';
import { ActionLedgerService } from '../action-ledger/service';
import { deriveTarget } from '../action-ledger/target-ref';
import {
  BLAST_RADIUS_GATE_REASON,
  commitBlastRadius,
  evaluateBlastRadius,
} from '../agent-execution/blast-radius-gate';
import { v4 as uuidv4 } from 'uuid';

const pool = getPoolForService('default');
const admissionService = new AdmissionService();
const actionLedger = new ActionLedgerService();

/**
 * Increment B producer: a gated connector call from sandbox code becomes a
 * pending approval that surfaces on /dashboard/review and is executed
 * server-side on approval (the sandbox script blocks on /mcp/await-approval).
 *
 * The sandbox dispatch has no agent ExecutionContext, so it generates
 * workflow/task UUIDs with no parent rows — exactly what migration 031 enabled
 * for scheduled/SDK executions: it dropped BOTH the NOT NULL and the FK
 * constraints on actions.{workflow_id,task_id} and
 * hitl_approval_requests.{workflow_id,task_id} ("scheduled invocations pass
 * UUIDs that have no corresponding workflow/task rows"). So no parent upsert is
 * needed (unlike workflow_escalations, which keeps its FKs). Both the pending
 * `actions` row (polled by await-approval) and the approval row are keyed on
 * `idempotencyKey`.
 */
async function createSandboxApproval(args: {
  tenantId: string; agentId: string; instructionVersion: number;
  toolName: string; connector: string; payload: Record<string, unknown>;
  idempotencyKey: string; traceId: string; reason: string; hitlLevel: number;
  /** The gate's own detail and record, when it states them (the contract
   *  check names the call, the probability and which contract). */
  detail?: string; context?: Record<string, unknown>;
}): Promise<void> {
  const workflowId = uuidv4();
  const taskId = uuidv4();
  // `String(payload?.id ?? payload?.targetRef ?? '')` is how the literal string
  // "null" can reach `target_ref`: an `id` key present but explicitly null
  // defeats `??`, and String(null) is "null" — which reads as a value to
  // everything downstream. deriveTarget returns '' for anything it cannot name.
  const target = deriveTarget({
    connector: args.connector,
    actionType: args.toolName,
    payload: args.payload,
  });
  // Pending action — this is the row /mcp/await-approval polls. recordIntent's
  // createAction has no ON CONFLICT, so tolerate a duplicate-key on retry
  // (the existing pending row already serves the poll).
  try {
    await actionLedger.recordIntent({
      tenantId: args.tenantId,
      agentId: args.agentId,
      workflowId,
      taskId,
      idempotencyKey: args.idempotencyKey,
      connector: args.connector,
      entityType: 'default',
      actionType: args.toolName,
      targetRef: target.ref,
      targetVersion: target.version,
      traceId: args.traceId,
      instructionVersion: args.instructionVersion,
      payload: args.payload,
    });
  } catch (err) {
    if ((err as { code?: string }).code !== '23505') throw err;
  }
  // Approval row — surfaces on /dashboard/review (idempotent on idempotency_key).
  await hitlEnforcementService.createApprovalRequest({
    tenantId: args.tenantId,
    workflowId,
    taskId,
    agentId: args.agentId,
    hitlLevel: args.hitlLevel,
    pendingToolCalls: [{ id: args.idempotencyKey, name: args.toolName, input: args.payload }],
    reason: args.reason as never,
    idempotencyKey: args.idempotencyKey,
    source: 'sandbox_code',
    invocationId: null, // D1 — sandbox connector calls carry no invocation context
    ...(args.detail ? { detail: args.detail } : {}),
    ...(args.context ? { context: args.context } : {}),
  });
}

export const sandboxMcpRouter = Router();
sandboxMcpRouter.use(requireSandboxJwt);

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extractConnectorAlias(toolName: string): string {
  const idx = toolName.indexOf('__');
  return idx > 0 ? toolName.slice(0, idx) : 'sandbox';
}

interface IntegrationRow {
  id: string;
  type?: string;
  alias?: string;
  selectedObjects?: string[];
  config?: Record<string, unknown>;
}

interface ManifestRow {
  id: string;
  alias: string;
  connector_type: string | null;
}

/** The sandbox's run context off its compiled instruction row: the
 *  integrations, and the instructions the contract check judges a dispatch
 *  against (the same row the sandbox JWT names by version). */
interface SandboxRunContext {
  integrations: IntegrationRow[];
  instruction: { systemPrompt?: string | null; userInstructions?: string | null; instructionsMd?: string | null };
}

async function loadSandboxRunContext(tenantId: string, agentId: string, instructionVersion: number): Promise<SandboxRunContext> {
  // RUNTIME_AGENT_ID_OK: agentId arrives in the sandbox JWT, which this service
  // signs from the execution context's runtime agent id when it launches the
  // sandbox (cloud-run-sandbox-provider.ts AGENT_ID). It never crosses the
  // control-plane boundary, so it is already runtime-space.
  const inst = await pool.query(
    `SELECT integrations, system_prompt, user_instructions, instructions_md FROM compiled_instructions
      WHERE tenant_id = $1 AND agent_id = $2 AND version = $3
      LIMIT 1`,
    [tenantId, agentId, instructionVersion],
  );
  const row = inst.rows[0] as {
    integrations?: unknown; system_prompt?: string | null; user_instructions?: string | null; instructions_md?: string | null;
  } | undefined;
  return {
    // Shared normalizer covers the PB integrationId↔type drift — see
    // instruction-compiler/integration-shape.ts.
    integrations: normalizeIntegrationsField(row?.integrations) as IntegrationRow[],
    instruction: {
      systemPrompt: row?.system_prompt ?? null,
      userInstructions: row?.user_instructions ?? null,
      instructionsMd: row?.instructions_md ?? null,
    },
  };
}

// Resolve the agent's connector manifests the SAME way the LLM catalog does
// (mcp-server.ts → connectorManifestRepository.getManifestsForAgent): match by
// connector_type / alias / id plus the connectors-table join, so it's robust to
// the PB integrationId↔type drift. The previous `WHERE id = ANY(integration ids)`
// query both missed type-keyed bindings AND selected a non-existent
// `tool_definitions` column (tool schemas live in the image, not the DB) — which
// threw and left every sandbox connector dispatch ungoverned/unresolved.
async function loadManifestsForAgent(tenantId: string, integrations: IntegrationRow[]): Promise<ManifestRow[]> {
  const allowedConnectors = deriveAllowedConnectors(integrations);
  if (allowedConnectors.length === 0) return [];
  const manifests = await connectorManifestRepository.getManifestsForAgent(tenantId, allowedConnectors);
  return manifests.map(m => ({ id: m.id, alias: m.alias, connector_type: m.connectorType ?? null }));
}

sandboxMcpRouter.get('/mcp/tools', async (req: RequestWithClaims, res) => {
  if (!req.sandboxClaims) return res.status(401).json({ error: 'unauthorized' });
  const { tenantId, agentId, instructionVersion } = req.sandboxClaims;
  try {
    const tools = await buildToolsForAgent(tenantId, agentId, instructionVersion);
    res.json({ tools });
  } catch (err) {
    log.error({ message: 'mcp/tools enumeration failed', err: (err as Error).message });
    res.status(500).json({ error: 'tools_enumeration_failed' });
  }
});

sandboxMcpRouter.post('/mcp/dispatch', async (req: RequestWithClaims, res) => {
  if (!req.sandboxClaims) return res.status(401).json({ error: 'unauthorized' });
  const claims = req.sandboxClaims;
  const { tool_name, args, idempotency_key } = req.body as { tool_name: string; args: Record<string, unknown>; idempotency_key?: string };

  // `invocation_id` comes back with the counter so a sandbox call can be
  // charged to the run that spawned it. The sandbox is a child of an
  // invocation, and its writes are that run's blast radius even though they
  // arrive over a separate HTTP request that may land on a different pod.
  const counterRow = await pool.query(
    'UPDATE sandbox_state SET mcp_dispatch_counter = mcp_dispatch_counter + 1 WHERE sandbox_id = $1 RETURNING mcp_dispatch_counter, invocation_id',
    [claims.sandboxId],
  );
  const counter: number = counterRow.rows[0]?.mcp_dispatch_counter ?? 1;
  const owningInvocationId: string | undefined = counterRow.rows[0]?.invocation_id ?? undefined;
  const traceId = `sandbox-${claims.sandboxId}-${counter}`;
  const idempotencyKey = idempotency_key ?? `${traceId}-${tool_name}`;

  const runContext = await loadSandboxRunContext(claims.tenantId, claims.agentId, claims.instructionVersion);
  const integrations = runContext.integrations;
  const manifests = await loadManifestsForAgent(claims.tenantId, integrations);
  const bindingsByType = buildBindingsByType(
    integrations.map(i => ({ id: i.id, type: i.type })) as unknown as Parameters<typeof buildBindingsByType>[0],
    manifests.map(m => ({ id: m.id, alias: m.alias, type: m.connector_type ?? undefined })) as unknown as Parameters<typeof buildBindingsByType>[1],
  );

  const input = {
    tenantId: claims.tenantId,
    agentId: claims.agentId,
    instructionVersion: claims.instructionVersion,
    traceId,
    idempotencyKey,
    connector: extractConnectorAlias(tool_name),
    entityType: 'default',
    actionType: tool_name,
    payload: args,
    estimatedCredits: 1,
    bindingsByType,
  };

  // Governance: a connector call made from agent-authored sandbox code MUST be
  // governed by the SAME workspace /oversight evaluation as an LLM tool call.
  // Without this, sandbox code bypasses HITL / kill-switch / sensitive-work
  // entirely (it reaches executeConnectorCall directly). We run the identical
  // checkHitlGate + communication gate the LLM loop runs.
  //   SANDBOX_HITL_ENFORCEMENT = off (no-op) | shadow (observe) | on (enforce).
  // - shadow: compute + LOG the decision with NO side effects (checkHitlGate
  //   dryRun; admission not run) and always execute — for safe rollout.
  // - on: enforce. Admission (incl. connector kill-switch) blocks with 402;
  //   a gated call blocks with 403. Increment A blocks (fail-closed); the agent
  //   can still perform the action via a normal LLM tool call, which has the
  //   pause→/review→approve flow. Increment B replaces the block with an
  //   in-place approval bridge.
  // The whole gate is wrapped: a governance FAILURE must not silently become an
  // ungoverned execution — fail-closed when on, fail-open when shadow.
  const hitlMode = (process.env.SANDBOX_HITL_ENFORCEMENT ?? 'shadow').toLowerCase();
  if (hitlMode === 'on' || hitlMode === 'shadow') {
    const enforcing = hitlMode === 'on';
    try {
      // Resolve the dispatched tool's connector type + governance metadata FIRST
      // (needed for both the admission connector kill-switch and the HITL gate),
      // from the SAME source the LLM catalog uses (getToolSchema).
      const aliasForTool = extractConnectorAlias(tool_name);
      const unprefixed = tool_name.includes('__') ? tool_name.slice(tool_name.indexOf('__') + 2) : tool_name;
      const manifestForTool = manifests.find(m => m.alias === aliasForTool);
      const connectorTypeForTool = manifestForTool?.connector_type ?? null;
      // A custom API connection's operations are PER INSTANCE, so the
      // type-keyed cache has nothing under `custom_api_connector` and a lookup
      // there returns null — which reads downstream as "this tool declares
      // nothing", not as "the lookup missed". That is the silent miss
      // `catalogTypeFor`'s own header is about, and here it would empty
      // `cats` for every operation of the connection: the destructive marker
      // gone, the Sensitive Work categories gone, and the HITL gate blind to
      // the whole connection on the sandbox dispatch path.
      const schema = connectorTypeForTool === CUSTOM_API_CONNECTOR_TYPE
        ? getCustomApiToolSchema(claims.tenantId, aliasForTool, unprefixed)
        : connectorTypeForTool ? getToolSchema(connectorTypeForTool, unprefixed) : null;
      const cats = (schema?.categories as string[] | undefined) ?? [];
      const modelTool = {
        name: tool_name,
        // Mirror the LLM catalog's destructive-marker convention (mcp-server.ts)
        // so checkHitlGate's level-2 destructive gate reads it identically.
        description: cats.includes('destructive') ? `⚠️ DESTRUCTIVE: ${schema?.description ?? ''}` : (schema?.description ?? ''),
        categories: cats,
        draftVariant: schema?.draftVariant ? `${aliasForTool}__${schema.draftVariant}` : undefined,
      };

      // Admission (enforcement-only): credit/suspension + connector kill-switch.
      // Skipped in shadow so shadow stays side-effect-free (checkAdmission can
      // trip the abuse-detection auto-suspend write path).
      if (enforcing) {
        const adm = await admissionService.checkAdmission({
          tenantId: claims.tenantId,
          agentId: claims.agentId,
          checkType: 'action',
          requiredCredits: 1,
          connectorType: connectorTypeForTool ?? undefined,
        });
        if (!adm.allowed) {
          log.warn({ message: 'sandbox-dispatch admission denied', tenantId: claims.tenantId, agentId: claims.agentId, tool_name, reason: adm.reason, quotaType: adm.quotaType });
          // 402 is this route's documented code for admission (403 means the
          // HITL gate held it) — the two must stay distinguishable to the
          // sandbox SDK. The body carries the machine-readable classification
          // so the caller never has to parse the prose.
          return res.status(402).json({
            success: false,
            error: `admission_denied: ${adm.reason}`,
            code: ADMISSION_DENIED_CODE,
            reason: adm.reason,
            quotaType: adm.quotaType,
          });
        }
      }

      // The same gate inputs the LLM loop passes (getOversightSettings +
      // getDefaultHitlLevel). dryRun in shadow → no rate-limit / audit writes.
      const oversight = await hitlEnforcementService.getOversightSettings(claims.tenantId);
      const hitlLevel = hitlEnforcementService.getDefaultHitlLevel(oversight?.autonomy ?? 'balanced');
      const gate = await hitlEnforcementService.checkHitlGate(
        [{ id: '', name: tool_name, input: args }],
        oversight,
        hitlLevel,
        [modelTool],
        claims.tenantId,
        claims.agentId,
        {
          dryRun: !enforcing,
          // Sandbox code chose this call itself: judged against the
          // instructions and role on the run's compiled instruction row.
          contract: instructionsContractOf(runContext.instruction),
          ...(owningInvocationId ? { invocationId: owningInvocationId } : {}),
        },
      );
      // Size, after kind — the same order the LLM loop uses.
      //
      // The run's totals live in `invocation_blast_radius`, keyed by the
      // invocation that owns this sandbox, so a script dispatching from another
      // pod accumulates into the same number the LLM loop reads. Without the
      // owning invocation there is nothing to accumulate against, and a
      // per-call measurement reported as a run total would under-count by
      // however much the script already did — so it is skipped rather than
      // guessed at.
      const blastState = {
        context: {
          tenantId: claims.tenantId,
          agentId: claims.agentId,
          ...(owningInvocationId ? { invocationId: owningInvocationId } : {}),
        },
      };
      const blast = owningInvocationId
        ? await evaluateBlastRadius(blastState, [{ name: tool_name, input: args }], 'sandbox-dispatch')
        : null;

      const comms = oversightDecisionFor({ categories: modelTool.categories, draftVariant: modelTool.draftVariant }, oversight);
      // The Communication setting reads the message here too (message-check.ts),
      // the same mapping as the LLM catalog's execute-time wrapper: under Auto
      // an unsafe message gates; under Review a matched message that is clear
      // on every ticked category runs.
      const verdict = await checkMessage({
        toolName: tool_name, categories: modelTool.categories, args, oversight, decision: comms,
        contract: instructionsContractOf(runContext.instruction), tenantId: claims.tenantId, agentId: claims.agentId,
        ...(owningInvocationId ? { invocationId: owningInvocationId } : {}),
      });
      // Any non-`allow` comms decision gates: in-sandbox code calls the outbound
      // tool directly, so we cannot silently swap it for the draft variant the
      // LLM catalog uses (skip_for_draft) — both block here.
      const commsGates = verdict.kind === 'pause' || (comms.kind !== 'allow' && verdict.kind !== 'send');
      const mustGate = gate.shouldGate || commsGates || blast?.shouldGate === true;
      if (mustGate) {
        const reason = gate.reason
          ?? (verdict.kind === 'pause' ? verdict.reason : undefined)
          ?? (comms.kind === 'require_approval' ? comms.reason : undefined)
          ?? (blast?.shouldGate ? BLAST_RADIUS_GATE_REASON : undefined)
          ?? 'communication_review';
        const gateContext = { ...(gate.context ?? {}), ...(verdict.context ?? {}) };
        log.warn({ message: 'sandbox-dispatch hitl gate', tenantId: claims.tenantId, agentId: claims.agentId, tool_name, reason, mode: hitlMode });
        if (enforcing) {
          await insertAuditLog(null, claims.tenantId, {
            internalAgentId: claims.agentId,
            invocationId: traceId,
            action: tool_name,
            inputArgs: args,
            outcome: 'gated',
            outputSummary: `pending_human_approval: ${reason}`,
            triggeredBy: 'sandbox_code',
            source: 'sandbox_code',
          }).catch(err => log.warn({ message: 'audit write failed', err: (err as Error).message }));
          // Increment B: create the pending approval (surfaces on /dashboard/review)
          // and return hitl_pending. The SDK blocks on /mcp/await-approval; on
          // approval the connector runs server-side and the result is returned to
          // the still-waiting sandbox script.
          await createSandboxApproval({
            tenantId: claims.tenantId, agentId: claims.agentId, instructionVersion: claims.instructionVersion,
            toolName: tool_name, connector: aliasForTool, payload: args,
            idempotencyKey, traceId, reason, hitlLevel,
            ...(gate.detail ? { detail: gate.detail } : {}),
            ...(Object.keys(gateContext).length ? { context: gateContext } : {}),
          });
          return res.json({ success: true, hitl_pending: true, idempotency_key: idempotencyKey });
        }
        // shadow: fall through and execute (observe-only)
      }
    } catch (gateErr) {
      // A governance evaluation failure must never silently downgrade to an
      // ungoverned connector call. Fail-closed when enforcing; fail-open in
      // shadow (shadow must not disrupt dispatches that would otherwise work).
      log.error({ message: 'sandbox-dispatch gate error', tenantId: claims.tenantId, agentId: claims.agentId, tool_name, mode: hitlMode, err: (gateErr as Error).message });
      if (enforcing) {
        return res.status(403).json({ success: false, error: 'requires_human_approval', hitl_required: true, reason: 'gate_unavailable' });
      }
    }
  }

  try {
    const gateway = toolGatewayService as unknown as { executeConnectorCall: (i: typeof input) => Promise<Record<string, unknown>> };
    const result = await gateway.executeConnectorCall(input);

    // Charge the owning run's blast-radius total, AFTER the call actually ran.
    // Committing at decision time would count a refused call, and a run that
    // gated and resumed would then be measured against work that only ever
    // existed as a proposal.
    if (owningInvocationId) {
      await commitBlastRadius(
        {
          context: {
            tenantId: claims.tenantId,
            agentId: claims.agentId,
            invocationId: owningInvocationId,
          },
        },
        [{ name: tool_name, input: args }],
      );
    }

    await insertAuditLog(null, claims.tenantId, {
      internalAgentId: claims.agentId,
      invocationId: traceId,
      action: tool_name,
      inputArgs: args,
      outputSummary: JSON.stringify((result as { data?: unknown }).data ?? {}).slice(0, 4000),
      outcome: (result as { success?: boolean }).success === false ? 'error' : 'success',
      triggeredBy: 'sandbox_code',
      source: 'sandbox_code',
    }).catch(err => log.warn({ message: 'audit write failed', err: (err as Error).message }));
    res.json(result);
  } catch (err) {
    log.error({ message: 'mcp dispatch failed', error: (err as Error).message });
    await insertAuditLog(null, claims.tenantId, {
      internalAgentId: claims.agentId,
      invocationId: traceId,
      action: tool_name,
      inputArgs: args,
      outcome: 'error',
      outputSummary: (err as Error).message.slice(0, 4000),
      triggeredBy: 'sandbox_code',
      source: 'sandbox_code',
    }).catch(auditErr => log.warn({ message: 'audit write failed', err: (auditErr as Error).message }));
    // An admission denial is a policy outcome with a named reason — 403 with
    // the reason in the body. A 500 here reads to the caller (and to the
    // recovery LLM downstream) as an infrastructure outage.
    if (err instanceof AdmissionDeniedError) {
      return res.status(403).json({
        success: false,
        error: err.message,
        code: err.code,
        reason: err.reason,
        quotaType: err.quotaType,
      });
    }
    res.status(500).json({ success: false, error: (err as Error).message });
  }
});

sandboxMcpRouter.post('/mcp/await-approval', async (req: RequestWithClaims, res) => {
  if (!req.sandboxClaims) return res.status(401).json({ error: 'unauthorized' });
  const claims = req.sandboxClaims;
  const { idempotencyKey, timeout_ms } = req.body as { idempotencyKey: string; timeout_ms?: number };
  const startMs = Date.now();
  const deadline = startMs + (timeout_ms ?? 60_000);
  while (Date.now() < deadline) {
    // actions table (migration 001) is the action persistence ledger. Status
    // transitions: 'pending' → 'approved' / 'rejected' / 'completed'. Approval
    // grants resume the tool dispatch via the existing HITL pause/resume flow.
    const row = await pool.query(
      `SELECT status, external_response FROM actions
        WHERE idempotency_key = $1 AND tenant_id = $2
        ORDER BY created_at DESC LIMIT 1`,
      [idempotencyKey, claims.tenantId],
    );
    const status = row.rows[0]?.status as string | undefined;
    if (status === 'completed' || status === 'approved') {
      return res.json({ status: 'approved', result: row.rows[0].external_response });
    }
    if (status === 'rejected') {
      return res.json({ status: 'rejected', reason: row.rows[0].external_response });
    }
    await sleep(2000);
  }
  res.status(408).json({ status: 'timeout' });
});
