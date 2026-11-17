// Tool Interceptor
//
// Enforces the tenant-level oversight `communication` policy on outbound
// tool calls before they reach the gateway. Two failure modes had
// silently let `communication='draft'` settings be ignored — both
// fixed here:
//
//   1. The earlier category check looked for tools tagged
//      'externalPublishing' / 'customerCommunication', which is the
//      vocabulary used by the Slack tool catalog. The connector-service
//      `connector-functions-registry` uses ['write', 'outbound'] for
//      every Gmail / Outlook / HubSpot / Salesforce send-style tool —
//      216 tools across the registry. With the old check, NONE of
//      those tools were recognised as outbound, so every reply_email,
//      send_email, forward_email, create_lead-with-side-effects etc.
//      slipped past the 'Draft first' policy and dispatched directly.
//      The fix adds 'outbound' (the registry's actual semantic) to the
//      recognised set so both vocabularies route correctly.
//
//   2. Tool registry draftVariants are hardcoded with the legacy
//      single-alias prefix (e.g. `google-mail__create_draft`). After
//      migration 252 introduced per-account aliases
//      (e.g. `google-mail-1a2b3c4d`), the legacy prefix points at a
//      tool that no longer exists in the agent's catalog. Even if the
//      category check fires, rewriting `google-mail-1a2b3c4d__reply_email`
//      → `google-mail__create_draft` produces an unroutable tool name.
//
//      The fix derives the alias prefix from the caller's tool name
//      itself (`google-mail-1a2b3c4d`), keeps the function suffix from
//      the registry's draftVariant (`create_draft`), and composes
//      `<currentAlias>__create_draft`. The registry can stay verbatim;
//      the interceptor handles per-account composition at runtime.

import { sensitiveWorkMatch } from '../tool-gateway/oversight-decision';
import { HitlGateError, OversightSettings, ModelTool, ToolCallRequest } from '../hitl-enforcement/types';
import { resolveCatalogTool } from '../hitl-enforcement/tool-name-resolution';

const OUTBOUND_CATEGORIES = new Set([
  // Slack tool catalog vocabulary (src/tool-gateway/agent-slack-tool-catalog.ts).
  'externalPublishing',
  'customerCommunication',
  // connector-functions-registry vocabulary (liftoff-connector-service).
  // Tagged on every send_email, reply_email, forward_email, create_draft,
  // schedule_message and equivalent vendor-side tools.
  'outbound',
]);

/**
 * Derive the agent-facing alias prefix from a tool name produced by the
 * catalog builder. Tool names follow `<alias>__<funcName>` where
 * `alias` itself can contain hyphens (e.g. the per-account alias
 * `google-mail-1a2b3c4d`). Split on the FIRST `__` so multi-hyphen
 * aliases survive.
 *
 * Returns null when the tool name doesn't follow the convention (e.g.
 * standard-tool names without an alias prefix), so the caller can fall
 * back to gating instead of producing a broken name.
 */
function extractAliasPrefix(toolName: string): string | null {
  const idx = toolName.indexOf('__');
  if (idx < 0) return null;
  const alias = toolName.slice(0, idx);
  return alias.length > 0 ? alias : null;
}

/**
 * Compose the per-account draft tool name from the caller's tool name
 * and the registry's draftVariant. Returns null when composition is
 * impossible (no alias prefix on the caller, or registry's draftVariant
 * doesn't carry a function suffix).
 */
function composeDraftToolName(callerToolName: string, registryDraftVariant: string): string | null {
  const callerAlias = extractAliasPrefix(callerToolName);
  if (!callerAlias) return null;
  const draftFnIdx = registryDraftVariant.indexOf('__');
  // No `__` in draftVariant — treat the whole value as the function suffix
  // (handles a future cleanup where the registry drops the prefix).
  const draftFn = draftFnIdx < 0 ? registryDraftVariant : registryDraftVariant.slice(draftFnIdx + 2);
  if (!draftFn) return null;
  return `${callerAlias}__${draftFn}`;
}

/**
 * Convert outbound tools to draft variants based on communication mode.
 *
 * When communication='draft', every outbound tool is rewritten to its
 * draft variant. When communication='review', outbound tools matching
 * an enabled sensitiveWork category are rewritten. When 'auto' (or
 * settings absent), the call passes through unchanged.
 *
 * Result on a converted call:
 *   Gmail   reply_email → create_draft (email saved to Drafts; user reviews in Gmail)
 *   Outlook send_email   → create_draft (saved in Outlook Drafts folder)
 *   Slack   send_message → HITL approval (no draft endpoint exists in
 *                          Slack's Web API; chat.scheduleMessage is a
 *                          delayed-send not a draft. Verified against
 *                          docs.slack.dev/reference/methods 2026-06-16.
 *                          maybeConvertToDraft throws HitlGateError,
 *                          the hybrid loop converts to a HITL pause +
 *                          approval row on the oversight dashboard.)
 */
export function maybeConvertToDraft(
  toolCall: ToolCallRequest,
  oversight: OversightSettings | undefined,
  tools: ModelTool[]
): ToolCallRequest {
  if (!oversight) {
    return toolCall;
  }

  // resolveCatalogTool, not a raw match. The model calls MCP tools as
  // `mcp__<serverId>__<name>` while the catalog stores `<name>`, so `find(===)` missed
  // every connector tool — and a miss here reads as `isOutbound === false`, meaning
  // this pre-check silently returned the call unchanged for precisely the tools it
  // exists to intercept. Fixing the guard in runAdapterHitlGate was not enough; this
  // lookup is a second, independent copy of the same defect.
  const tool = resolveCatalogTool(toolCall.name, tools);
  const isOutbound = tool?.categories?.some(cat => OUTBOUND_CATEGORIES.has(cat));
  if (!isOutbound) {
    return toolCall;
  }

  const rewriteToDraft = (): ToolCallRequest => {
    // First-choice: registry-provided draftVariant, with per-account
    // alias composition. Fall back to gating when either the registry
    // doesn't define a draft variant OR composition fails (e.g. the
    // caller's name doesn't carry an alias prefix).
    if (tool?.draftVariant) {
      // Compose from the RESOLVED catalog name, never the raw call name. An
      // SDK-prefixed `mcp__liftoff-tool-gateway__google-mail-1a2b3c4d__reply_email`
      // splits on its first `__` to the alias "mcp", composing the unroutable
      // `mcp__create_draft`. That was unreachable while the lookup above always
      // missed; resolving the tool makes this path live, so it has to compose from
      // `tool.name` — which is the catalog form the alias convention describes.
      const composed = composeDraftToolName(tool.name, tool.draftVariant);
      if (composed) {
        return { ...toolCall, name: composed };
      }
    }
    throw new HitlGateError([toolCall], 'communication_review');
  };

  if (oversight.communication === 'draft') {
    return rewriteToDraft();
  }

  if (oversight.communication === 'review') {
    const matched = sensitiveWorkMatch(tool, oversight.sensitiveWork);
    if (matched) {
      // Review means a person approves the send itself; substituting a draft
      // would hand them a different action from the one they were asked about.
      // The pause is the decision, whether or not a draft form exists.
      throw new HitlGateError([toolCall], 'sensitive_work', matched);
    }
  }

  return toolCall; // communication='auto' or 'review' on a non-sensitive call
}

/**
 * Process a batch of tool calls, converting to drafts as needed.
 */
export function interceptToolCalls(
  toolCalls: ToolCallRequest[],
  oversight: OversightSettings | undefined,
  tools: ModelTool[]
): ToolCallRequest[] {
  return toolCalls.map(tc => maybeConvertToDraft(tc, oversight, tools));
}
