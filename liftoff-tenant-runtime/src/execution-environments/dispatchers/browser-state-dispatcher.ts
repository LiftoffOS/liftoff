import type { Dispatcher, DispatchInput, DispatchCtx, DispatchResult } from './types';

const SUPPORTED = new Set(['browser_state_save', 'browser_state_load', 'browser_state_list', 'browser_state_delete']);

export const browserStateDispatcher: Dispatcher = {
  supports: name => SUPPORTED.has(name),
  async handle(call: DispatchInput, ctx: DispatchCtx): Promise<DispatchResult> {
    const { provider } = ctx;
    const { sandboxId } = call;
    const input = call.input;
    switch (call.toolName) {
      case 'browser_state_save':
        return { success: true, data: await provider.browserStateSave(sandboxId, input.tabId as string, input.stateId as string | undefined) };
      case 'browser_state_load':
        return { success: true, data: await provider.browserStateLoad(sandboxId, input.stateId as string) };
      case 'browser_state_list':
        return { success: true, data: await provider.browserStateList(sandboxId) };
      case 'browser_state_delete':
        await provider.browserStateDelete(sandboxId, input.stateId as string);
        return { success: true, data: {} };
      default:
        return { success: false, error: `unhandled tool: ${call.toolName}` };
    }
  },
};
