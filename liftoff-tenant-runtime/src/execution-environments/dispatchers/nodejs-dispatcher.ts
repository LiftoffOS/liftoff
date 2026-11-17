import type { Dispatcher, DispatchInput, DispatchCtx, DispatchResult } from './types';

const SUPPORTED = new Set([
  'nodejs_session_create',
  'nodejs_execute',
  'nodejs_session_delete',
]);

export const nodejsDispatcher: Dispatcher = {
  supports: name => SUPPORTED.has(name),
  async handle(call: DispatchInput, ctx: DispatchCtx): Promise<DispatchResult> {
    const { provider } = ctx;
    const { sandboxId } = call;
    const input = call.input;
    switch (call.toolName) {
      case 'nodejs_session_create':
        return { success: true, data: await provider.nodejsSessionCreate(sandboxId) };
      case 'nodejs_execute':
        return { success: true, data: await provider.nodejsExecute(sandboxId, input.sessionId as string, input.code as string) };
      case 'nodejs_session_delete':
        await provider.nodejsSessionDelete(sandboxId, input.sessionId as string);
        return { success: true, data: {} };
      default:
        return { success: false, error: `unhandled tool: ${call.toolName}` };
    }
  },
};
