// External Agent Handler
// Per implementation plan: Handles A2A communication with external AI agents via MCP
// Reuses existing HITL enforcement per tenant settings

import { v4 as uuidv4 } from 'uuid';
import { logger } from '../infrastructure/logging';
import { getPoolForService } from '../infrastructure/database';
import { getPlatformBackendUrl } from '../infrastructure/runtime-env';
import { hitlEnforcementService } from '../hitl-enforcement/service';
import { insertAuditLog } from '../audit';
import { assertMcpUrlAllowed, assertAllowlistMatchesTenant } from '../security/mcp-url-guard';
import { getTenantAllowlistProvider } from '../security/tenant-allowlist-provider';
import type { ToolCallRequest, ModelTool, OversightSettings, GateResult } from '../hitl-enforcement/types';
import { instructionsContractOf, type HitlContract } from '../hitl-enforcement/contract-check';
import type { MCPTransport, TransportType } from './transports';
import { createTransportSync } from './transports';
import { interpretMcpToolCallResult, inputRequiredError } from './mcp-result';
import { listExternalAgentTools, isUnknownToolError } from './external-agent-tools';
import { clearVendorMcpToolListCache } from '../agent-execution/adapter/vendor-mcp-enumerate';
import {
  BLAST_RADIUS_GATE_REASON,
  commitBlastRadius,
  evaluateBlastRadius,
} from '../agent-execution/blast-radius-gate';
import { getManagedSecret } from '../infrastructure/secret-store';

// Request permission type
type RequestPermission = 'allowed' | 'approval_required' | 'blocked';

// Request type classification - must match Platform Backend types.ts RequestType
// These map to the permission matrix configured in the Platform Backend UI
type RequestType =
  | 'read_summaries'   // Read-only operations, viewing data
  | 'run_analysis'     // Processing/analyzing without changes
  | 'draft_outputs'    // Creating content (comms, publishing)
  | 'propose_updates'; // Making changes to data/systems

// Per-internal-agent request rule
interface InternalAgentRequestRule {
  internalAgentId: string;
  permissions: Record<RequestType, RequestPermission>;
}

// External agent config fetched from control plane
export interface ExternalAgentConfig {
  id: string;
  tenantId: string;
  name: string;
  endpointUrl: string;
  transportType: TransportType;
  authType: 'none' | 'api_key' | 'bearer_token' | 'custom_headers';
  collaborationMode: 'request_help' | 'receive_delegated' | 'two_way' | 'observe_only';
  allowedInternalAgentIds: string[];
  requestRules: InternalAgentRequestRule[]; // Per-team permission rules
  toolClassifications: Record<string, string[]>; // toolName -> categories
  /** 1b: the confident effect class per bare tool name, from the control
   *  plane's classifier. Appended to the tool's categories at the gate so the
   *  level-2 destructive rule and the effect-based checks see it. Absent from
   *  an older control plane; empty while its classifier kill is off. */
  toolEffectClasses?: Record<string, string>;
  rawMcpTools: MCPToolDefinition[];
  /** Fully-qualified Secret Manager resource name for this agent's credentials
   *  (`projects/{project}/secrets/{name}`), as recorded by platform-backend when
   *  it wrote the secret. Authoritative: PB writes to the tenant project or the
   *  control-plane project depending on tenants.gcp_project_id, so this runtime
   *  cannot reconstruct the path on its own. Absent on rows written before the
   *  change — getCredentials falls back to the legacy construction. */
  credentialSecretName?: string | null;
  status: 'connected' | 'disconnected' | 'error' | 'pending_review';
  summary: string | null;              // For system prompt injection
  collaborationHints: string | null;   // For system prompt injection
  timeoutMs?: number;                  // A2A poll timeout (default 300_000)
}

const EFFECT_CLASSES: ReadonlySet<string> = new Set(['read', 'write', 'destructive', 'outbound']);

/** Exported for the handler test. */
export function appendEffectClass(categories: string[], effectClass: string | undefined): string[] {
  if (!effectClass || !EFFECT_CLASSES.has(effectClass) || categories.includes(effectClass)) return categories;
  return [...categories, effectClass];
}

// MCP tool definition
interface MCPToolDefinition {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

/** An authenticated external agent whose secret could not be read.
 *  Never downgrade to an unauthenticated call — surface it. */
export class ExternalAgentCredentialsUnavailableError extends Error {
  constructor(public readonly externalAgentId: string, reason: string) {
    super(`Credentials unavailable for external agent ${externalAgentId}: ${reason}`);
    this.name = 'ExternalAgentCredentialsUnavailableError';
  }
}

// Credentials fetched from tenant's Secret Manager
export interface ExternalAgentCredentials {
  authType: 'none' | 'api_key' | 'bearer_token' | 'custom_headers';
  apiKey?: string;
  bearerToken?: string;
  customHeaders?: Array<{ key: string; value: string }>;
}

// Execute input for external agent
export interface ExternalAgentExecuteInput {
  tenantId: string;
  agentId: string; // The internal agent making the request
  instructionVersion: number;
  traceId: string;
  idempotencyKey: string;
  externalAgentId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  requestDirection?: 'outbound' | 'inbound';  // Direction of request
  skipHitl?: boolean;  // Phase 3.5D: skip HITL when already enforced by SDK PreToolUse hook
  /** Owning invocation (invocations.id), forwarded to any HITL approval created here so it
   *  carries the m312 correlation + the per-invocation training label read by the trajectory
   *  assembler. Real for OUTBOUND calls (the tool-gateway threads the caller's invocation,
   *  service.ts); undefined for INBOUND / external-origin requests (→ NULL on the approval row).
   *  NOTE: external-agent calls do carry invocation context on the outbound path, where a real
   *  caller invocation exists — linking it is strictly more correct than discarding it. */
  invocationId?: string;
}

// Execute result
export interface ExternalAgentExecuteResult {
  success: boolean;
  data: unknown;
  traceId: string;
  error?: string;
  gatePending?: boolean; // True if HITL approval required
  approvalId?: string;
}

// Cache for external agent configs (short TTL)
const configCache = new Map<string, { config: ExternalAgentConfig; fetchedAt: number }>();
const CONFIG_CACHE_TTL_MS = 60_000; // 1 minute

export class ExternalAgentHandler {
  private controlPlaneUrl: string;
  private controlPlaneToken: string;
  private requestId = 0;

  constructor() {
    // Env-specific platform-backend URL via runtime-env.ts. The prior
    // `CONTROL_PLANE_API_URL || CONTROL_PLANE_URL || prod-alias` fallback
    // chain was a cross-env trust footgun (dev → prod calls).
    this.controlPlaneUrl = getPlatformBackendUrl();
    this.controlPlaneToken = getManagedSecret('TENANT_RUNTIME_SERVICE_TOKEN') || process.env.CONTROL_PLANE_SERVICE_TOKEN || '';
  }

  /**
   * Execute a tool call on an external agent via MCP
   * Follows the 8-step action execution flow from the plan
   *
   * ID-SPACE NOTE: input.agentId is the RUNTIME agents.id (the per-tenant
   * runtime database's primary key for the agent). The platform backend
   * stores external_agents.allowed_internal_agent_ids and request_rules
   * keyed on the PLATFORM internal_agents.id (a separate ID space). This
   * function translates between the two via the
   * internal_agent_runtime_mapping table at the start of execution, then
   * uses:
   *   - `runtimeAgentId` for any read/write to the RUNTIME database
   *     (audit_logs.internal_agent_id, hitl_approval_requests.agent_id,
   *     triggered_by tags) — these columns store runtime ids despite the
   *     misleading "internal_agent_id" name on the audit_logs column.
   *   - `internalAgentId` for any check against PLATFORM data
   *     (config.allowedInternalAgentIds, config.requestRules.internalAgentId).
   *
   * Without this translation, every cross-runtime external-agent tool call
   * fails the Layer 2 authorization check because the runtime id will not
   * appear in the platform's allowed_internal_agent_ids list.
   */
  async execute(input: ExternalAgentExecuteInput): Promise<ExternalAgentExecuteResult> {
    const { tenantId, traceId, externalAgentId, toolName, toolInput } = input;
    const runtimeAgentId = input.agentId;

    // Translate runtime agent id → platform internal agent id via the
    // mapping table. If no mapping exists (e.g., the agent was created
    // before the mapping table existed, or the mapping row got lost), fall
    // back to the runtime id — the authorization check will then either
    // succeed (if the IDs happen to match, which they normally don't)
    // or fail with a clear "not authorized" error rather than silently
    // bypassing the check.
    const internalAgentId = await this.resolveInternalAgentId(tenantId, runtimeAgentId);

    logger.info({
      traceId,
      tenantId,
      runtime_agent_id: runtimeAgentId,
      internal_agent_id: internalAgentId,
      externalAgentId,
      toolName,
    }, 'External agent tool call started');

    // Step 1: Fetch external agent config from control plane (with cache)
    const config = await this.getExternalAgentConfig(tenantId, externalAgentId);

    if (!config) {
      return {
        success: false,
        data: null,
        traceId,
        error: `External agent ${externalAgentId} not found`,
      };
    }

    if (config.status !== 'connected') {
      return {
        success: false,
        data: null,
        traceId,
        error: `External agent ${externalAgentId} is not connected (status: ${config.status})`,
      };
    }

    // Step 2: Validate internal agent has access to this external agent (Layer 2: Internal Agent Authorization)
    // Uses PLATFORM internal_agent_id (translated above), not the runtime agent_id.
    if (!config.allowedInternalAgentIds.includes(internalAgentId)) {
      logger.warn({
        traceId,
        runtime_agent_id: runtimeAgentId,
        internal_agent_id: internalAgentId,
        externalAgentId,
        allowedInternalAgentIds: config.allowedInternalAgentIds,
      }, 'Internal agent not authorized to use external agent');

      return {
        success: false,
        data: null,
        traceId,
        error: `Internal agent ${internalAgentId} is not authorized to use external agent ${externalAgentId}`,
      };
    }

    // Layer 3: Collaboration Mode Direction Check
    const requestDirection = this.determineRequestDirection(input);
    const modeAllowsDirection: Record<string, string[]> = {
      'request_help': ['outbound'],           // Internal → External only
      'receive_delegated': ['inbound'],       // External → Internal only
      'two_way': ['outbound', 'inbound'],     // Both directions
      'observe_only': [],                     // No active requests allowed
    };

    if (!modeAllowsDirection[config.collaborationMode].includes(requestDirection)) {
      logger.warn({
        traceId,
        runtime_agent_id: runtimeAgentId,
        internal_agent_id: internalAgentId,
        externalAgentId,
        collaborationMode: config.collaborationMode,
        requestDirection,
      }, 'Collaboration mode does not allow this request direction');

      return {
        success: false,
        data: null,
        traceId,
        error: `Collaboration mode '${config.collaborationMode}' does not allow ${requestDirection} requests`,
      };
    }

    // Layer 4: Per-Internal-Agent Request Rules
    // Uses PLATFORM internal_agent_id (translated above), not the runtime agent_id.
    const teamRule = config.requestRules?.find(r => r.internalAgentId === internalAgentId);
    const requestType = this.classifyRequestType(toolName, config.toolClassifications);

    if (teamRule) {
      const permission = teamRule.permissions[requestType] || 'approval_required';

      if (permission === 'blocked') {
        logger.warn({
          traceId,
          runtime_agent_id: runtimeAgentId,
          internal_agent_id: internalAgentId,
          externalAgentId,
          toolName,
          requestType,
        }, 'Request type is blocked for this internal agent');

        return {
          success: false,
          data: null,
          traceId,
          error: `Request type '${requestType}' is blocked for internal agent ${internalAgentId}`,
        };
      }

      if (permission === 'approval_required') {
        logger.info({
          traceId,
          toolName,
          requestType,
          reason: 'Per-internal-agent request rule requires approval',
        }, 'External agent tool call requires HITL approval (per-internal-agent rule)');

        // Create HITL approval request — runtime DB write, uses runtime agent id.
        const approvalRequest = await hitlEnforcementService.createApprovalRequest({
          tenantId,
          // No workflow context for an external-agent call: absent, never blank.
          agentId: runtimeAgentId,
          hitlLevel: 3,
          pendingToolCalls: [{
            id: `ext_${this.requestId++}`,
            name: `${config.name}:${toolName}`,
            input: toolInput,
          }],
          reason: `Per-internal-agent request rule requires approval for '${requestType}' requests`,
          idempotencyKey: input.idempotencyKey,
          invocationId: input.invocationId,
        });

        // Audit log gated external agent call (per-team rule) — runtime DB
        // write, uses runtime agent id. The audit_logs.internal_agent_id
        // column name is misleading; it stores the runtime agents.id.
        await insertAuditLog(null, tenantId, {
          internalAgentId: runtimeAgentId,
          externalAgentId,
          action: `external-agent_${config.name}_${toolName}`,
          inputArgs: toolInput,
          outcome: 'gated',
          triggeredBy: `agent:${runtimeAgentId}`,
        });

        return {
          success: false,
          data: null,
          traceId,
          gatePending: true,
          approvalId: approvalRequest.id,
        };
      }
      // permission === 'allowed' - continue to next layer
    }

    // Step 3: Fetch credentials, then validate the tool against the agent's
    // CURRENT tool list.
    //
    // Credentials are resolved here rather than after the gate because the
    // live `tools/list` needs them. Checking `config.rawMcpTools` instead was
    // the reason a call to a tool the server had dropped passed validation and
    // died at the far end with `Unknown tool`: the snapshot being validated
    // against was the same stale snapshot that offered the tool.
    // Skips the Secret Manager round-trip entirely when authType is 'none'
    // (public APIs like CoinGecko), which would otherwise NOT_FOUND every call.
    let credentials: ExternalAgentCredentials;
    try {
      credentials = config.authType === 'none'
        ? { authType: 'none' }
        : await this.getCredentials(tenantId, externalAgentId, config.authType, config.credentialSecretName);
    } catch (credErr) {
      // Refuse the call rather than silently issuing it unauthenticated.
      return {
        success: false,
        data: null,
        traceId,
        error: (credErr as Error).message,
      };
    }

    const liveTools = await listExternalAgentTools(config, credentials);
    const toolDef = liveTools.find(t => t.name === toolName);
    if (!toolDef) {
      return {
        success: false,
        data: null,
        traceId,
        error: `Tool ${toolName} not found on external agent ${externalAgentId}`,
      };
    }

    // Step 4: Check HITL gate using existing enforcement
    // Phase 3.5D: Skip HITL if already enforced by SDK PreToolUse hook
    if (input.skipHitl) {
      logger.info({ traceId, toolName, skipHitl: true }, 'Skipping HITL gate (already enforced in SDK hook)');
    }
    let gateResult: GateResult = input.skipHitl
      ? { shouldGate: false }
      : await this.checkHitlGate(input, config);

    // Size, after kind — the same order the LLM loop uses.
    //
    // What the OTHER agent goes on to change is measured in its own run. What
    // is measured here is this run's fan-out: a call to an external agent is
    // one effectful action, and a run issuing hundreds of them has a real blast
    // radius that no per-call check and no child's totals would ever show.
    //
    // Skipped when the SDK hook already decided (`skipHitl`) — re-gating a
    // decision already made cannot make progress.
    let blastReasons: string[] = [];
    if (!gateResult.shouldGate && !input.skipHitl && input.invocationId) {
      const blastState = {
        context: {
          tenantId,
          agentId: input.agentId,
          invocationId: input.invocationId,
        },
      };
      const blast = await evaluateBlastRadius(
        blastState,
        [{ name: `${config.name}:${toolName}`, input: input.toolInput }],
        'external-agent',
      );
      if (blast?.shouldGate) {
        gateResult = { shouldGate: true, reason: BLAST_RADIUS_GATE_REASON };
        blastReasons = blast.reasons;
      }
    }

    if (gateResult.shouldGate) {
      logger.info({
        traceId,
        toolName,
        reason: gateResult.reason,
      }, 'External agent tool call requires HITL approval');

      // Create HITL approval request — runtime DB write, uses runtime agent id.
      const approvalRequest = await hitlEnforcementService.createApprovalRequest({
        tenantId,
        // No workflow context for an external-agent call: absent, never blank.
        agentId: runtimeAgentId,
        hitlLevel: 3, // Default to balanced for external agents
        pendingToolCalls: [{
          id: `ext_${this.requestId++}`,
          name: `${config.name}:${toolName}`,
          input: toolInput,
        }],
        reason: gateResult.reason || 'external_agent_gate',
        idempotencyKey: input.idempotencyKey,
        invocationId: input.invocationId,
        ...(blastReasons.length > 0 ? { detail: blastReasons.join(' ') } : {}),
      });

      // Audit log gated external agent call (HITL gate) — runtime DB write.
      await insertAuditLog(null, tenantId, {
        internalAgentId: runtimeAgentId,
        externalAgentId,
        action: `external-agent_${config.name}_${toolName}`,
        inputArgs: toolInput,
        outcome: 'gated',
        triggeredBy: `agent:${runtimeAgentId}`,
      });

      return {
        success: false,
        data: null,
        traceId,
        gatePending: true,
        approvalId: approvalRequest.id,
      };
    }

    // The gate cleared it, so this call is about to happen: charge the run's
    // blast-radius total now. Committing at decision time would count a call
    // that gated and never ran, and a resumed run would then measure against
    // work that only ever existed as a proposal.
    if (input.invocationId) {
      await commitBlastRadius(
        { context: { tenantId, agentId: input.agentId, invocationId: input.invocationId } },
        [{ name: `${config.name}:${toolName}`, input: toolInput }],
      );
    }

    // Step 6-8: Execute tool call (MCP or A2A) — credentials resolved in step 3.
    const startTime = Date.now();
    try {
      // Snapshot the tenant's MCP URL allowlist once per tool call so the
      // SSRF guard accepts Custom MCP Server URLs, external_agents URLs,
      // and the tunnel routes registered for this tenant.
      const tenantAllowlist = await getTenantAllowlistProvider().get(tenantId);
      // Defense-in-depth: catch any wrong-snapshot bug at the dispatch
      // boundary before the URL guard is even invoked.
      assertAllowlistMatchesTenant(tenantAllowlist, tenantId);

      const result = config.transportType === 'a2a'
        ? await this.executeA2aAgent(config, credentials, toolInput, traceId, tenantAllowlist)
        : await this.executeMcpToolCall(config, credentials, toolName, toolInput, traceId, tenantAllowlist);

      const durationMs = Date.now() - startTime;
      // Interpret the MCP 2026-07-28 tool-result envelope (no-op for A2A):
      //  - inputRequired (MRTR): the server needs interactive input mid-call,
      //    which this dispatch path can't provide — fail cleanly.
      //  - isError: the tool ran but returned an error result — surface it as a
      //    failure (content preserved in `data`) instead of reporting success.
      const { inputRequired, isError: isErrorResult } = interpretMcpToolCallResult(result);

      // The server says this tool does not exist, so our cached list is stale.
      // Drop it; the next enumeration re-fetches. With the live list on the
      // catalog path this is belt-and-braces — the 5-minute TTL self-heals
      // anyway — but it closes the window immediately instead of at expiry.
      if (isErrorResult && isUnknownToolError(result)) {
        clearVendorMcpToolListCache();
        logger.warn(
          { traceId, toolName, externalAgentId },
          'external agent reported unknown tool — cleared the cached tool list',
        );
      }

      logger.info({
        traceId,
        toolName,
        externalAgentId,
        durationMs,
        inputRequired,
        isError: isErrorResult,
      }, 'External agent tool call completed');

      // Audit log the external agent call — runtime DB write.
      await insertAuditLog(null, tenantId, {
        internalAgentId: runtimeAgentId,
        externalAgentId,
        action: `external-agent_${config.name}_${toolName}`,
        inputArgs: toolInput,
        outputSummary: inputRequired
          ? 'input_required (MRTR) — not fulfillable mid-call'
          : `${isErrorResult ? 'Tool error' : 'Success'}: ${JSON.stringify(result).slice(0, 200)}`,
        outcome: inputRequired || isErrorResult ? 'error' : 'success',
        triggeredBy: `agent:${runtimeAgentId}`,
        durationMs,
      });

      if (inputRequired) {
        return { success: false, data: null, error: inputRequiredError(toolName), traceId };
      }
      return {
        success: !isErrorResult,
        data: result,
        ...(isErrorResult ? { error: `MCP tool ${toolName} returned an error result` } : {}),
        traceId,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      const durationMs = Date.now() - startTime;

      logger.error({
        traceId,
        toolName,
        externalAgentId,
        error: message,
        durationMs,
      }, 'External agent tool call failed');

      // Audit log failed external agent call — runtime DB write.
      await insertAuditLog(null, tenantId, {
        internalAgentId: runtimeAgentId,
        externalAgentId,
        action: `external-agent_${config.name}_${toolName}`,
        inputArgs: toolInput,
        outputSummary: `Error: ${message}`,
        outcome: 'error',
        errorCode: 'EXTERNAL_AGENT_ERROR',
        triggeredBy: `agent:${runtimeAgentId}`,
        durationMs,
      });

      return {
        success: false,
        data: null,
        traceId,
        error: message,
      };
    }
  }

  /**
   * Translate runtime agents.id → platform internal_agents.id via the
   * internal_agent_runtime_mapping table.
   *
   * The runtime database's `agents.id` and the platform database's
   * `internal_agents.id` are separate ID spaces. The platform stores
   * external_agents.allowed_internal_agent_ids and request_rules keyed on
   * the PLATFORM internal_agents.id, but the runtime calls this handler
   * with the RUNTIME agents.id as the `agentId` parameter. Without this
   * translation, every authorization check inside execute() fails because
   * the runtime id will not appear in the platform's allow list.
   *
   * If the mapping row is missing (defensive: e.g., the agent was created
   * before the mapping table existed, or the mapping row got lost), we
   * return the runtime id unchanged. The Layer 2 authorization check will
   * then fail loudly with "not authorized" rather than silently bypass.
   * This is the safe default — it produces a clear error message instead
   * of letting an unauthorized call through.
   */
  private async resolveInternalAgentId(
    tenantId: string,
    runtimeAgentId: string
  ): Promise<string> {
    try {
      const pool = getPoolForService('scheduled-execution');
      const result = await pool.query(
        `SELECT internal_agent_id FROM internal_agent_runtime_mapping
         WHERE agent_id = $1 AND tenant_id = $2`,
        [runtimeAgentId, tenantId]
      );
      if (result.rows[0]?.internal_agent_id) {
        return result.rows[0].internal_agent_id;
      }
      logger.warn({
        runtime_agent_id: runtimeAgentId,
        tenant_id: tenantId,
      }, 'No internal_agent_runtime_mapping row found, falling back to runtime agent id (will likely fail authorization)');
      return runtimeAgentId;
    } catch (error) {
      logger.error({
        runtime_agent_id: runtimeAgentId,
        tenant_id: tenantId,
        error: (error as Error).message,
      }, 'Failed to resolve internal agent id from mapping table, falling back to runtime agent id');
      return runtimeAgentId;
    }
  }

  /**
   * Translate platform internal_agents.id → runtime agents.id via the
   * internal_agent_runtime_mapping table. This is the inverse of
   * resolveInternalAgentId() and is used by the inbound A2A path
   * (executeInbound) where the external system identifies the target
   * agent by its PLATFORM internal_agents.id but the tool gateway
   * expects the RUNTIME agents.id for downstream lookups (compiled
   * instruction lookup, agent lifecycle check, audit log, etc.).
   *
   * Returns null if no mapping row exists. Callers should treat this
   * as "agent not provisioned in this tenant runtime" and reject the
   * inbound request — the safe default is to refuse rather than
   * proceed with a lookup that will produce empty/wrong data.
   */
  private async resolveRuntimeAgentId(
    tenantId: string,
    internalAgentId: string
  ): Promise<string | null> {
    try {
      const pool = getPoolForService('scheduled-execution');
      const result = await pool.query(
        `SELECT agent_id FROM internal_agent_runtime_mapping
         WHERE internal_agent_id = $1 AND tenant_id = $2`,
        [internalAgentId, tenantId]
      );
      if (result.rows[0]?.agent_id) {
        return result.rows[0].agent_id;
      }
      logger.warn({
        internal_agent_id: internalAgentId,
        tenant_id: tenantId,
      }, 'No internal_agent_runtime_mapping row for inbound request — rejecting');
      return null;
    } catch (error) {
      logger.error({
        internal_agent_id: internalAgentId,
        tenant_id: tenantId,
        error: (error as Error).message,
      }, 'Failed to resolve runtime agent id from mapping table for inbound request');
      return null;
    }
  }

  /**
   * Check HITL gate for external agent tool call
   * Uses classifications from discovery time (stored on external agent config)
   */
  private async checkHitlGate(
    input: ExternalAgentExecuteInput,
    config: ExternalAgentConfig
  ): Promise<GateResult> {
    // agentId is intentionally not destructured: this gate path resolves
    // oversight settings by tenantId only and does not need an agent id.
    const { tenantId, toolName } = input;

    // Get tenant oversight settings
    const oversight = await hitlEnforcementService.getOversightSettings(tenantId);

    // Get HITL level for the calling team
    // TODO: Look up team's hitlLevel from control plane
    const hitlLevel = await hitlEnforcementService.resolveHitlLevel(tenantId, undefined);

    // Build ModelTool from external agent's tool definition with classifications,
    // the 1b effect class appended (never replacing) when the control plane
    // stored one, so a sensitivity signal already on the tool is never dropped.
    const toolDef = config.rawMcpTools.find(t => t.name === toolName);
    const categories = appendEffectClass(config.toolClassifications[toolName] || [], config.toolEffectClasses?.[toolName]);

    const tools: ModelTool[] = [{
      name: `${config.name}:${toolName}`,
      description: toolDef?.description || '',
      categories,
    }];

    const toolCalls: ToolCallRequest[] = [{
      id: `ext_${this.requestId++}`,
      name: `${config.name}:${toolName}`,
      input: input.toolInput,
    }];

    // Reuse existing HITL enforcement logic. The model chose this call
    // itself, so the contract check judges it against the instructions and
    // role on the calling run's compiled instruction row, and the usage
    // record names the owning invocation.
    return hitlEnforcementService.checkHitlGate(
      toolCalls,
      oversight as OversightSettings | undefined,
      hitlLevel,
      tools,
      tenantId,
      undefined,
      {
        contract: await this.loadInstructionsContract(tenantId, input.agentId, input.instructionVersion),
        ...(input.invocationId ? { invocationId: input.invocationId } : {}),
      },
    );
  }

  /** The instructions contract of the run making this call, off the compiled
   *  instruction row its input names (runtime agents.id + version): the same
   *  row and the same builder the sandbox dispatch path reads. Undefined when
   *  the row is absent or carries nothing, which the gate logs once as
   *  `contract_check.no_contract`; an inbound request names version 0 and has
   *  no run to judge against. A read failure is undefined too: the gate
   *  decides as today rather than failing the call. */
  private async loadInstructionsContract(
    tenantId: string,
    runtimeAgentId: string,
    instructionVersion: number,
  ): Promise<HitlContract | undefined> {
    if (!instructionVersion) return undefined;
    try {
      const pool = getPoolForService('scheduled-execution');
      const result = await pool.query(
        `SELECT system_prompt, user_instructions, instructions_md FROM compiled_instructions
          WHERE tenant_id = $1 AND agent_id = $2 AND version = $3
          LIMIT 1`,
        [tenantId, runtimeAgentId, instructionVersion],
      );
      const row = result.rows[0] as {
        system_prompt?: string | null; user_instructions?: string | null; instructions_md?: string | null;
      } | undefined;
      if (!row) return undefined;
      return instructionsContractOf({
        systemPrompt: row.system_prompt ?? null,
        userInstructions: row.user_instructions ?? null,
        instructionsMd: row.instructions_md ?? null,
      });
    } catch (error) {
      logger.warn({
        tenant_id: tenantId,
        runtime_agent_id: runtimeAgentId,
        instruction_version: instructionVersion,
        error: (error as Error).message,
      }, 'Failed to load the compiled instruction row for the contract check; the gate decides without a contract');
      return undefined;
    }
  }

  /**
   * Fetch external agent config from control plane (with cache)
   */
  private async getExternalAgentConfig(
    tenantId: string,
    externalAgentId: string
  ): Promise<ExternalAgentConfig | null> {
    const cacheKey = `${tenantId}:${externalAgentId}`;
    const cached = configCache.get(cacheKey);

    if (cached && Date.now() - cached.fetchedAt < CONFIG_CACHE_TTL_MS) {
      return cached.config;
    }

    try {
      // Use the service-auth endpoint at /api/external-agents/by-id (mounted via
      // externalAgentInternalRouter on the platform backend, BEFORE the Firebase auth
      // middleware). The legacy path /api/external-agents/:id sits behind Firebase auth
      // and 401s on X-Service-Auth, so we cannot use it for service-to-service calls.
      const url = new URL(`${this.controlPlaneUrl}/api/external-agents/by-id`);
      url.searchParams.set('tenantId', tenantId);
      url.searchParams.set('id', externalAgentId);

      const response = await fetch(url.toString(), {
        headers: {
          'X-Service-Auth': this.controlPlaneToken,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        if (response.status === 404) {
          return null;
        }
        throw new Error(`Failed to fetch external agent config: ${response.status}`);
      }

      const config = await response.json() as ExternalAgentConfig;
      configCache.set(cacheKey, { config, fetchedAt: Date.now() });

      return config;
    } catch (error) {
      logger.error({
        tenantId,
        externalAgentId,
        error: (error as Error).message,
      }, 'Failed to fetch external agent config');

      // Return cached config if available (stale is better than nothing)
      return cached?.config || null;
    }
  }

  /**
   * Fetch credentials from Secret Manager.
   *
   * Caller should pass `authType` to short-circuit the Secret Manager call when
   * authType is 'none' — that skips a noisy warn log and a pointless GCP call
   * on every public-API external agent invocation (e.g. CoinGecko).
   *
   * WHERE the secret lives: platform-backend writes it to the TENANT's project
   * when tenants.gcp_project_id is set and to the CONTROL-PLANE project when it
   * is not. This function used to reconstruct the path from
   * GCP_PROJECT_ID alone — always the tenant project — so for those tenants it
   * looked in the wrong place every time. PB now stores the fully-qualified
   * resource name and hands it over on the config; the reconstruction below is
   * the legacy fallback for rows written before that. Same fix custom MCP
   * servers already carry (custom-mcp-server-handler.ts authSecretResourceName).
   *
   * THROWS rather than failing open. The previous `catch → {authType:'none'}`
   * turned any Secret Manager miss into a silent downgrade: an integration the
   * operator configured with a bearer token would quietly call a third party
   * with no credentials at all. A hard error is the only honest outcome — see
   * the no-stub-success invariant.
   */
  private async getCredentials(
    tenantId: string,
    externalAgentId: string,
    authType?: 'none' | 'api_key' | 'bearer_token' | 'custom_headers',
    credentialSecretName?: string | null,
  ): Promise<ExternalAgentCredentials> {
    // Caller-side fast path: skip the Secret Manager call entirely for
    // public APIs that don't authenticate (e.g., CoinGecko).
    if (authType === 'none') {
      return { authType: 'none' };
    }

    // Prefer the resolved resource name PB recorded when it wrote the secret.
    // Legacy fallback: reconstruct against this runtime's own project.
    let resourceName: string;
    if (credentialSecretName && credentialSecretName.startsWith('projects/')) {
      resourceName = credentialSecretName.includes('/versions/')
        ? credentialSecretName
        : `${credentialSecretName}/versions/latest`;
    } else {
      // Secret name format: external-agent-{id}-{tenantId}
      const secretName = credentialSecretName || `external-agent-${externalAgentId}-${tenantId}`;
      // GCP_PROJECT_ID is the canonical name set on every Cloud Run revision via
      // cloudbuild --set-env-vars. TENANT_PROJECT_ID is also set as a duplicate
      // alias for backwards compat with older deploys; we accept either.
      const tenantProjectId = process.env.GCP_PROJECT_ID || process.env.TENANT_PROJECT_ID;
      if (!tenantProjectId) {
        throw new ExternalAgentCredentialsUnavailableError(
          externalAgentId,
          'Neither GCP_PROJECT_ID nor TENANT_PROJECT_ID is set in the environment',
        );
      }
      resourceName = `projects/${tenantProjectId}/secrets/${secretName}/versions/latest`;
    }

    try {
      // Import dynamically to avoid loading Secret Manager when not needed
      const { SecretManagerServiceClient } = await import('@google-cloud/secret-manager');
      const client = new SecretManagerServiceClient();
      const [version] = await client.accessSecretVersion({ name: resourceName });
      const secretValue = version.payload?.data?.toString() || '{}';
      return JSON.parse(secretValue) as ExternalAgentCredentials;
    } catch (error) {
      logger.error({
        tenantId,
        externalAgentId,
        resourceName,
        error: (error as Error).message,
      }, 'external agent credentials unavailable — refusing to call unauthenticated');
      throw new ExternalAgentCredentialsUnavailableError(externalAgentId, (error as Error).message);
    }
  }

  /**
   * Credentials for CATALOG BUILDING (enumeration only), never for dispatch.
   *
   * Enumeration must not be able to fail a run: if the secret is unreadable we
   * return no-auth and let listExternalAgentTools' `tools/list` fail, which
   * degrades to the stored snapshot. That is safe precisely because listing
   * takes no action on the third party — unlike execute(), which refuses
   * outright rather than issue an unauthenticated call.
   */
  public async resolveCredentialsForEnumeration(
    config: ExternalAgentConfig,
  ): Promise<ExternalAgentCredentials> {
    if (config.authType === 'none') return { authType: 'none' };
    try {
      return await this.getCredentials(
        config.tenantId, config.id, config.authType, config.credentialSecretName,
      );
    } catch {
      return { authType: 'none' };
    }
  }

  /**
   * Execute an outbound A2A call: fetch Agent Card, call SendMessage, poll GetTask.
   * SSRF protection: both the card URL and RPC URL are validated by assertMcpUrlAllowed.
   */
  private async executeA2aAgent(
    config: ExternalAgentConfig,
    credentials: ExternalAgentCredentials,
    toolInput: Record<string, unknown>,
    traceId: string,
    tenantAllowlist?: import('../security/mcp-url-guard').TenantAllowlistContext,
  ): Promise<unknown> {
    // Build auth headers from stored credentials
    const authHeaders: Record<string, string> = {};
    if (credentials.authType === 'bearer_token' && credentials.bearerToken) {
      authHeaders['Authorization'] = `Bearer ${credentials.bearerToken}`;
    } else if (credentials.authType === 'api_key' && credentials.apiKey) {
      authHeaders['X-Service-Token'] = credentials.apiKey;
    } else if (credentials.authType === 'custom_headers' && credentials.customHeaders) {
      for (const h of credentials.customHeaders) authHeaders[h.key] = h.value;
    }

    // SSRF guard on the Agent Card URL
    assertMcpUrlAllowed(config.endpointUrl, tenantAllowlist);

    const cardResponse = await fetch(config.endpointUrl, {
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      signal: AbortSignal.timeout(10_000),
    });
    if (!cardResponse.ok) {
      throw new Error(`Failed to fetch Agent Card from ${config.endpointUrl}: ${cardResponse.status}`);
    }

    const agentCard = await cardResponse.json() as {
      supportedInterfaces?: { url: string }[];
    };
    const rpcUrl = agentCard.supportedInterfaces?.[0]?.url;
    if (!rpcUrl) {
      throw new Error('Agent Card missing supportedInterfaces[0].url');
    }

    // SSRF guard on the RPC URL
    assertMcpUrlAllowed(rpcUrl, tenantAllowlist);

    const contextId = uuidv4();
    const objective = typeof toolInput.objective === 'string'
      ? toolInput.objective
      : JSON.stringify(toolInput);

    const sendResponse = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'SendMessage',
        params: {
          message: {
            role: 'user',
            messageId: `${traceId}-msg`,
            contextId,
            parts: [{ text: objective }],
          },
        },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!sendResponse.ok) {
      throw new Error(`A2A SendMessage failed: ${sendResponse.status}`);
    }
    const sendResult = await sendResponse.json() as {
      result?: { task?: { id: string } };
      error?: { message: string };
    };
    if (sendResult.error) throw new Error(`A2A SendMessage error: ${sendResult.error.message}`);

    const taskId = sendResult.result?.task?.id;
    if (!taskId) throw new Error('A2A SendMessage did not return a task id');

    // Poll GetTask until terminal or timeout
    const timeoutMs = config.timeoutMs ?? 300_000;
    const pollStart = Date.now();
    while (true) {
      if (Date.now() - pollStart > timeoutMs) {
        throw new Error(`A2A task ${taskId} timed out after ${timeoutMs}ms`);
      }
      await new Promise<void>((r) => setTimeout(r, 2_000));

      const pollResponse = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'GetTask', params: { id: taskId } }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!pollResponse.ok) throw new Error(`A2A GetTask failed: ${pollResponse.status}`);
      const pollResult = await pollResponse.json() as {
        result?: { task?: { status: string; output?: unknown } };
        error?: { message: string };
      };
      if (pollResult.error) throw new Error(`A2A GetTask error: ${pollResult.error.message}`);

      const status = pollResult.result?.task?.status;
      if (status === 'completed') return pollResult.result?.task?.output ?? { status: 'completed', taskId };
      if (status === 'failed') throw new Error(`A2A task ${taskId} failed`);
      // submitted / working / input-required — keep polling
    }
  }

  /**
   * Execute MCP tool call via transport abstraction
   * Supports both Streamable HTTP and SSE transports
   */
  private async executeMcpToolCall(
    config: ExternalAgentConfig,
    credentials: ExternalAgentCredentials,
    toolName: string,
    toolInput: Record<string, unknown>,
    traceId: string,
    tenantAllowlist?: import('../security/mcp-url-guard').TenantAllowlistContext,
  ): Promise<unknown> {
    // SSRF guard on the MCP server URL.
    assertMcpUrlAllowed(config.endpointUrl, tenantAllowlist);
    // Create transport based on stored transport type (never 'a2a' — handled by executeA2aAgent)
    const transport: MCPTransport = createTransportSync(
      (config.transportType || 'streamable-http') as Exclude<TransportType, 'a2a'>,
      {
        endpointUrl: config.endpointUrl,
        authType: credentials.authType,
        apiKey: credentials.apiKey,
        bearerToken: credentials.bearerToken,
        customHeaders: credentials.customHeaders,
        timeout: 30_000,
      }
    );

    try {
      // Connect (required for SSE transport)
      await transport.connect();

      logger.debug({
        traceId,
        transportType: transport.getType(),
        endpoint: config.endpointUrl,
        toolName,
      }, 'Executing MCP tool call');

      // Execute tool call
      const result = await transport.request<unknown>('tools/call', {
        name: toolName,
        arguments: toolInput,
      });

      return result;
    } finally {
      transport.close();
    }
  }

  /**
   * Clear config cache for an external agent
   * Called by Pub/Sub handler when external agent is updated/deleted
   */
  clearConfigCache(cacheKey: string): void {
    configCache.delete(cacheKey);
    logger.info({ cacheKey }, 'Cleared external agent config cache');
  }

  /**
   * Determine request direction based on input
   * Per implementation plan: Layer 3 helper
   */
  private determineRequestDirection(input: ExternalAgentExecuteInput): 'outbound' | 'inbound' {
    // If requestDirection is explicitly set, use it
    if (input.requestDirection) {
      return input.requestDirection;
    }

    // Default: outbound (internal agent calling external agent)
    return 'outbound';
  }

  /**
   * Classify request type from tool name and classifications
   * Per implementation plan: Layer 4 helper - maps sensitivity categories to request types
   *
   * Maps tool sensitivity categories to the 4 request types used in permission rules:
   * - read_summaries: Read-only operations
   * - run_analysis: Processing without side effects
   * - draft_outputs: Creating content (communications, publishing)
   * - propose_updates: Making changes to data/systems
   */
  private classifyRequestType(
    toolName: string,
    classifications: Record<string, string[]>
  ): RequestType {
    const categories = classifications[toolName] || [];

    // Tools that modify data or make critical decisions → propose_updates
    if (
      categories.includes('dataChanges') ||
      categories.includes('financialActions') ||
      categories.includes('hiringDecisions')
    ) {
      return 'propose_updates';
    }

    // Tools that create outputs for external consumption → draft_outputs
    if (
      categories.includes('customerCommunication') ||
      categories.includes('externalPublishing')
    ) {
      return 'draft_outputs';
    }

    // Tools with no sensitive categories → run_analysis (safe default)
    // Note: read_summaries is available but run_analysis is more permissive
    // for tools that do processing without obvious side effects
    return 'run_analysis';
  }

  /**
   * Execute an inbound request from an external agent
   * Per implementation plan Phase 5: Inbound API endpoint handler
   */
  async executeInbound(input: {
    externalAgentId: string;
    tenantId: string;
    teamId: string;
    toolName: string;
    toolInput: unknown;
    authHeader: string;
    requestId?: string;
  }): Promise<ExternalAgentExecuteResult> {
    const { externalAgentId, tenantId, teamId, toolName, toolInput, authHeader } = input;
    const traceId = `a2a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Step 1: Fetch external agent config (includes stored credentials)
    const config = await this.getExternalAgentConfig(tenantId, externalAgentId);
    if (!config) {
      return { success: false, data: null, traceId, error: 'External agent not found' };
    }

    // Step 2: Validate credentials
    const isValid = await this.validateInboundCredentials(config, authHeader);
    if (!isValid) {
      return { success: false, data: null, traceId, error: 'Invalid credentials' };
    }

    // Step 3: Check collaboration mode allows inbound
    if (!['request_help', 'two_way'].includes(config.collaborationMode)) {
      return {
        success: false,
        data: null,
        traceId,
        error: `Collaboration mode '${config.collaborationMode}' does not allow inbound requests`
      };
    }

    // Step 4: Check internal agent is in allowedInternalAgentIds
    if (!config.allowedInternalAgentIds.includes(teamId)) {
      return { success: false, data: null, traceId, error: 'Internal agent not authorized' };
    }

    // Step 5: Check per-internal-agent request rules
    // teamId is the PLATFORM internal_agents.id (provided by the inbound
    // request from the external system); request_rules.internalAgentId on
    // the platform side uses the same id space, so the comparison is correct.
    const requestType = this.classifyRequestType(toolName, {});
    const permission = this.getInternalAgentRequestPermission(config.requestRules, teamId, requestType);
    if (permission === 'blocked') {
      return { success: false, data: null, traceId, error: 'Request type blocked for this internal agent' };
    }

    // Step 6: Translate platform internal_agents.id → runtime agents.id
    // before routing to the tool gateway. The tool gateway's `agentId`
    // parameter is the runtime id, used for compiled instruction lookup,
    // agent lifecycle check, audit log writes, and triggered_by tags. If
    // we passed teamId (a platform id) directly, every downstream lookup
    // would silently miss because the runtime database doesn't know that
    // id. Refuse the inbound request if no mapping exists rather than
    // proceeding with a known-broken id.
    const runtimeAgentId = await this.resolveRuntimeAgentId(tenantId, teamId);
    if (!runtimeAgentId) {
      return {
        success: false,
        data: null,
        traceId,
        error: `Internal agent ${teamId} is not provisioned in this tenant runtime`,
      };
    }

    // Step 7: Route to Tool Gateway for internal agent execution.
    // Phase 4: dispatcher picks in-process vs HTTP based on SERVICE_TYPE.
    const { getToolGatewayDispatcher } = await import('./dispatcher');
    const toolGateway = getToolGatewayDispatcher();

    const result = await toolGateway.execute({
      tenantId,
      agentId: runtimeAgentId,
      instructionVersion: 0, // Inbound requests don't have instruction context
      traceId,
      idempotencyKey: input.requestId || traceId,
      connector: 'internal',
      entityType: 'agent',
      actionType: toolName,
      payload: toolInput as Record<string, unknown>,
    });

    return {
      success: result.success,
      data: result.data,
      traceId,
      error: result.error,
    };
  }

  /**
   * Validate inbound credentials from external agent
   * Per implementation plan Phase 5.3
   */
  private async validateInboundCredentials(
    config: ExternalAgentConfig,
    authHeader: string
  ): Promise<boolean> {
    // Fetch stored credentials for this external agent. An unreadable secret
    // now throws rather than degrading to {authType:'none'} — on the INBOUND
    // path that must reject the request, never wave it through as unauthenticated.
    let credentials: ExternalAgentCredentials;
    try {
      credentials = await this.getCredentials(
        config.tenantId, config.id, config.authType, config.credentialSecretName,
      );
    } catch {
      return false;
    }

    switch (config.authType) {
      case 'api_key':
        // Compare API key from header with stored key
        return authHeader === `ApiKey ${credentials.apiKey}`;

      case 'bearer_token':
        // Compare bearer token
        return authHeader === `Bearer ${credentials.bearerToken}`;

      case 'none':
        // No authentication required
        return true;

      default:
        return false;
    }
  }

  /**
   * Get per-internal-agent permission for a request type
   * Per implementation plan: Helper for inbound request authorization
   */
  private getInternalAgentRequestPermission(
    requestRules: InternalAgentRequestRule[],
    teamId: string,
    requestType: RequestType
  ): RequestPermission {
    const teamRule = requestRules.find(r => r.internalAgentId === teamId);
    if (!teamRule) {
      return 'approval_required'; // Default if no rule exists
    }
    return teamRule.permissions[requestType] || 'approval_required';
  }
}

export const externalAgentHandler = new ExternalAgentHandler();
