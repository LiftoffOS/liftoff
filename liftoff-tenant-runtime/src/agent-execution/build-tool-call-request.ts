/**
 * Build a ToolCallRequest from a canonical aliased tool name.
 *
 * Tool names are constructed as `${sanitizedAlias}__${funcName}` by buildToolsSchema.
 * The family resolver splits on the FIRST `__` to extract connector (alias) and
 * actionType (func), and resolves every other shape by name.
 *
 * Special cases:
 *   - 'external__alias__toolName' -> connector='external', actionType='alias__toolName'
 *   - 'shell_exec' (sandbox)      -> connector='execution_environment'
 *   - 'slack_send_message'        -> connector='agent_slack'
 *   - 'search', 'delegate_to_agent' -> connector='__builtin:<name>'
 *   - 'note_save' (standard tool) -> connector='', actionType=toolName
 *
 * A bare name used to become connector='' unconditionally, which sent 116 tools
 * the runtime CAN execute into `executeStandardTool`, which has a case for none
 * of them and returns null. See tool-dispatch-family.ts for the full account.
 *
 * Phase 4: replaces the broken split('_')[0] in runWorkflowLoop.
 */

import type { ToolCallRequest } from './types';
import { resolveToolDispatch, entityTypeForDispatch } from './tool-dispatch-family';
import { isStandardTool } from '../tools/standard-tools';

export function buildToolCallRequest(
  toolName: string,
  payload: Record<string, unknown>,
  opts: { id: string; entityType?: string; isStandardTool?: (name: string) => boolean },
): ToolCallRequest {
  // The standard-tool catalog's own membership predicate. Overridable so tests
  // can drive the resolver without the handler graph.
  const dispatch = resolveToolDispatch(toolName, opts.isStandardTool ?? isStandardTool);

  // `unresolved` still produces a request rather than throwing. The throw
  // belongs at validation, which refuses the workflow before a run starts and
  // can name the step; here it would surface mid-run as an opaque crash. The
  // empty connector reproduces the previous behaviour exactly — dispatch fails
  // loudly in `executeStandardTool` with "no handler registered" — so an
  // unresolved name is no worse off than before, and every resolvable one is
  // now routed.
  const connector = dispatch.kind === 'unresolved' ? '' : dispatch.connector;

  return {
    id: opts.id,
    connector,
    entityType: entityTypeForDispatch(
      dispatch,
      opts.entityType || (connector === '' ? 'standard' : 'workflow'),
    ),
    actionType: dispatch.actionType,
    payload,
  };
}
