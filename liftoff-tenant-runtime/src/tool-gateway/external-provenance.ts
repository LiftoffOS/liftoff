// Provenance for the tools that never reach this gateway's dispatcher.
//
// `checkWriteProvenance` and `recordProvenance` had exactly one caller each,
// both inside `tool-gateway/service.ts`. That covered the catalog connectors
// and nothing else: `resolveVendorMcpServers` hands the engine a DIRECT
// connection to a vendor-hosted MCP server — GitHub, Stripe, Notion, and every
// `custom_mcp_server` a customer brings — so those calls are dispatched by the
// vendor SDK (Anthropic) or the bridge's client pool (every wire engine), and
// never enter `execute()`.
//
// Both halves were missing, which is why it read as working. Their reads never
// entered the provenance store, so nothing they wrote could have been
// provenanced; and their writes were never judged, so nothing ever said so.
//
// TWO SEAMS, BECAUSE A CHECK AND A RECORD HAPPEN AT DIFFERENT MOMENTS.
//
//   guardExternalToolCall  — BEFORE dispatch, from the adapter gate
//                            (`runAdapterHitlGate`), which every engine calls
//                            for every tool: Anthropic through the SDK's
//                            `canUseTool`, the wire engines through mcp-bridge.
//                            This is the one place a direct-dispatch write can
//                            be REFUSED, so it is where the verdict is produced
//                            and reported.
//   recordExternalToolResult — AFTER dispatch, from the engine's event stream,
//                            which is the one place the RESULT is visible. It
//                            records and reports nothing: the verdict was
//                            already produced above, and a second report would
//                            double the denominator.
//
// Both run in the process that owns the store. Every deployment sets
// TOOL_GATEWAY_SERVICE_URL, so the engine runs in agent-service and the store
// lives in tool-gateway-service; evaluated where the engine runs, a check would
// judge against a map nothing writes.

import {
  type ProvenanceDeclaration,
  checkFloorProvenance,
  checkWriteProvenance,
  holdMessage,
  provenanceEnforcedFor,
  provenanceGateMode,
  recordProvenance,
  reportProvenance,
} from './record-provenance';
import { isWriteAction, connectorTypeFromAlias } from '../action-ledger/target-ref';
import { isOwnGatewayTool } from '../hitl-enforcement/tool-name-resolution';
import { parseVendorToolName } from '../action-ledger/record-external-tool-call';
import { toolResultData, toolResultFailure } from './mcp-result';
import { logger } from '../infrastructure/logging';
import { catalogTypeFor } from '../connectors/tool-schema-cache';
import { vendorReadReturning } from '../connectors/vendor-declarations';

/**
 * Judge one write the gateway will not dispatch, before it runs.
 *
 * Returns the hold to hand the model, or null to let the call proceed. Null is
 * also the answer for everything that is not a vendor-hosted write, for a
 * failed check, and for a connector not on the enforce list — the last of
 * those still REPORTS, which is the whole shadow signal.
 *
 * Never throws. A broken check is not grounds to refuse a call.
 */
export async function guardExternalToolCall(
  args: {
    tenantId: string;
    agentId: string;
    invocationId: string | undefined;
    toolName: string;
    input: Record<string, unknown> | undefined;
  },
  /** Resolved by the caller from the schema cache, the way `execute()` does.
   *  A vendor-hosted tool DOES have one: discovery carries no declarations, so
   *  the cache derives `idArgs` from each tool's input schema at the mappers
   *  every tool enters by. Passed in rather than looked up here so this
   *  function stays pure and the lookup has one home. */
  declaration: ProvenanceDeclaration | undefined,
): Promise<string | null> {
  if (provenanceGateMode() === 'off') return null;
  // Our own tools are judged inside `execute()`; judging them here as well
  // would report every verdict twice.
  if (isOwnGatewayTool(args.toolName)) return null;

  const parsed = parseVendorToolName(args.toolName);
  if (!parsed) return null;
  if (!isWriteAction(parsed.actionType)) return null;

  try {
    // THE DECLARATION IS WHAT MAKES A HOLD POSSIBLE. With none, the precise
    // check answers `no_declaration` — provenanced by definition — and only the
    // floor speaks, which is reported and never acted on. A first version of
    // this passed `undefined` on the reasoning that a vendor-hosted server has
    // no catalog row, and so built an enforcement seam that could refuse
    // nothing. The cache's own comment names GitHub, the pilot's connector,
    // as the reason the derivation exists.
    const verdict = await checkWriteProvenance({
      tenantId: args.tenantId,
      invocationId: args.invocationId,
      declaration,
      actionType: parsed.actionType,
      payload: args.input,
    });
    reportProvenance({
      mode: provenanceGateMode(),
      verdict,
      connector: parsed.connector,
      actionType: parsed.actionType,
      tenantId: args.tenantId,
      agentId: args.agentId,
      dispatch: 'direct',
      ...(args.invocationId ? { invocationId: args.invocationId } : {}),
    });

    const floorUnseen = await checkFloorProvenance({
      tenantId: args.tenantId,
      invocationId: args.invocationId,
      payload: args.input,
      connector: parsed.connector,
      // The run's own names. A floor that demands provenance for the id a run
      // was handed is asking where it heard of itself.
      runContext: [args.agentId, args.tenantId],
    });
    if (floorUnseen.length > 0) {
      logger.warn({
        event: 'provenance_floor_would_block',
        metric: 'provenance.floor_would_block',
        dispatch: 'direct',
        connector: parsed.connector,
        actionType: parsed.actionType,
        unseen: floorUnseen.slice(0, 10),
        tenantId: args.tenantId,
        agentId: args.agentId,
        invocationId: args.invocationId,
      }, 'heuristic floor: this write names an identifier the run has not read');
    }

    // Refuse only what the allowlist names, and only on a verdict the precise
    // check produced from a declaration a person wrote. The floor's view is
    // reported and never acted on, exactly as on the gateway path — and so is
    // a verdict from a derived declaration: both are heuristics, and a
    // heuristic that refuses is a false positive with a customer on the
    // other end.
    if (!verdict.provenanced && provenanceEnforcedFor(parsed.connector, declaration)) {
      return holdMessage({
        connector: connectorTypeFromAlias(parsed.connector),
        actionType: parsed.actionType,
        unseen: verdict.unseen,
        // The hand-written declarations are the one place a vendor-hosted read
        // says what it returns; when none does, the hold's generic form still
        // says which connector to read from first.
        readToRun: vendorReadReturning(catalogTypeFor(parsed.connector), declaration?.entityType),
      });
    }
    return null;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, toolName: args.toolName, invocationId: args.invocationId },
      'external_provenance_guard_failed (non-fatal)',
    );
    return null;
  }
}

/**
 * Remember what one call the gateway did not dispatch returned, for the writes
 * that follow it.
 *
 * Records only. The verdict for this call, if it was a write, was produced and
 * reported by `guardExternalToolCall` before it ran; reporting here too would
 * count every direct-dispatch write twice in the denominator the readiness
 * report reads.
 *
 * Never throws: the call has already happened, and a failure here must not turn
 * a completed action into a reported one.
 */
export async function recordExternalToolResult(
  args: {
    tenantId: string;
    agentId: string;
    invocationId: string | undefined;
    toolName: string;
    input: Record<string, unknown> | undefined;
    result: unknown;
    error?: string;
  },
  declaration: ProvenanceDeclaration | undefined,
): Promise<boolean> {
  // Returns whether the store now holds what this call returned (or had
  // nothing to hold). A caller marking the call remembered may do so only on
  // true; this used to return nothing, and a store write that threw was
  // indistinguishable from one that landed.
  if (provenanceGateMode() === 'off') return true;
  if (isOwnGatewayTool(args.toolName)) return true;
  // A failed call establishes nothing and acted on nothing — and the event
  // seldom says it failed: a denied gate and an `isError` envelope both arrive
  // with no error field. Read the result.
  if (args.error ?? toolResultFailure(args.result)) return true;

  const parsed = parseVendorToolName(args.toolName);
  if (!parsed) return true;

  try {
    const isWrite = isWriteAction(parsed.actionType);
    // The DATA, not the envelope. A vendor server's result is MCP content —
    // JSON inside a text part — and on the OpenAI wire that sits inside the
    // SDK's own text wrapper as well. A declared path finds nothing in a
    // string, and the floor sees one long string that is no identifier; read
    // against the envelope, a vendor read established nothing, ever.
    const data = toolResultData(args.result);
    return await recordProvenance({
      tenantId: args.tenantId,
      invocationId: args.invocationId,
      declaration,
      actionType: parsed.actionType,
      payload: args.input,
      result: data,
      isWrite,
      floor: true,
    });
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, toolName: args.toolName, invocationId: args.invocationId },
      'external_provenance_not_recorded',
    );
    return false;
  }
}
