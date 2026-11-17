import type { Dispatcher, DispatchInput, DispatchCtx, DispatchResult } from './types';

const SUPPORTED = new Set(['mcp_list_tools', 'mcp_dispatch', 'mcp_await_approval']);

export const mcpDispatcher: Dispatcher = {
  supports: name => SUPPORTED.has(name),
  async handle(call: DispatchInput, ctx: DispatchCtx): Promise<DispatchResult> {
    const { provider } = ctx;
    const { sandboxId } = call;
    const input = call.input;
    if (call.toolName === 'mcp_list_tools') {
      return { success: true, data: await provider.mcpListTools(sandboxId) };
    }
    if (call.toolName === 'mcp_dispatch') {
      return { success: true, data: await provider.mcpDispatch(sandboxId, input.tool_name as string, input.args as Record<string, unknown>, input.idempotency_key as string | undefined) };
    }
    if (call.toolName === 'mcp_await_approval') {
      return { success: true, data: await provider.mcpAwaitApproval(sandboxId, input.idempotencyKey as string, input.timeout_ms as number) };
    }
    return { success: false, error: `unhandled tool: ${call.toolName}` };
  },
};
