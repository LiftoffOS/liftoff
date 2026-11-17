import type { Dispatcher, DispatchInput, DispatchCtx, DispatchResult } from './types';

const SUPPORTED = new Set(['code_execute', 'code_get_info']);

export const codeDispatcher: Dispatcher = {
  supports: name => SUPPORTED.has(name),
  async handle(call: DispatchInput, ctx: DispatchCtx): Promise<DispatchResult> {
    const { provider } = ctx;
    const { sandboxId } = call;
    const input = call.input;
    switch (call.toolName) {
      case 'code_execute':
        return { success: true, data: await provider.codeExecute(sandboxId, input as Parameters<typeof provider.codeExecute>[1]) };
      case 'code_get_info':
        return { success: true, data: { languages: ['python', 'javascript', 'bash'] } };
      default:
        return { success: false, error: `unhandled tool: ${call.toolName}` };
    }
  },
};
