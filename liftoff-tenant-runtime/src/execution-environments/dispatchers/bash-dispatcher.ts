import { liveResourcesRepository } from '../live-resources-repository';
import type { Dispatcher, DispatchInput, DispatchCtx, DispatchResult } from './types';

const SUPPORTED = new Set([
  'bash_session_create',
  'bash_session_exec',
  'bash_session_kill',
  'bash_session_list',
]);

export const bashDispatcher: Dispatcher = {
  supports: name => SUPPORTED.has(name),
  async handle(call: DispatchInput, ctx: DispatchCtx): Promise<DispatchResult> {
    const { provider } = ctx;
    const { sandboxId } = call;
    const input = call.input;
    switch (call.toolName) {
      case 'bash_session_create': {
        const cwd = (input.cwd as string | undefined) ?? '/workspace';
        const handle = await provider.bashSessionCreate(sandboxId, { cwd: input.cwd as string | undefined, env: input.env as Record<string, string> | undefined });
        await liveResourcesRepository.trackBashCreated(
          { sandboxId, tenantId: call.tenantId, agentId: call.agentId, invocationId: call.invocationId },
          handle.sessionId,
          cwd,
        );
        return { success: true, data: handle };
      }
      case 'bash_session_exec':
        return { success: true, data: await provider.bashSessionExec(sandboxId, input.sessionId as string, input.args as string[], input.timeout_ms as number | undefined) };
      case 'bash_session_kill':
        await provider.bashSessionKill(sandboxId, input.sessionId as string);
        await liveResourcesRepository.trackBashClosed(sandboxId, input.sessionId as string);
        return { success: true, data: {} };
      case 'bash_session_list':
        return { success: true, data: await provider.bashSessionList(sandboxId) };
      default:
        return { success: false, error: `unhandled tool: ${call.toolName}` };
    }
  },
};
