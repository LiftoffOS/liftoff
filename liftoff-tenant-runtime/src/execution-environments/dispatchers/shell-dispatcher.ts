import { validateWorkspacePath } from '@liftoffos/sandbox-validators';
import { liveResourcesRepository } from '../live-resources-repository';
import type { Dispatcher, DispatchInput, DispatchCtx, DispatchResult } from './types';

const SUPPORTED = new Set([
  'shell_exec',
  'shell_session_create',
  'shell_session_write',
  'shell_session_view',
  'shell_session_wait',
  'shell_session_kill',
  'shell_session_resize',
  'shell_session_cleanup',
  'shell_session_cleanup_all',
  'shell_session_stats',
  'shell_session_list',
]);

export const shellDispatcher: Dispatcher = {
  supports: name => SUPPORTED.has(name),
  async handle(call: DispatchInput, ctx: DispatchCtx): Promise<DispatchResult> {
    const { provider } = ctx;
    const { sandboxId } = call;
    const input = call.input;
    switch (call.toolName) {
      case 'shell_exec': {
        const args = input.args as string[];
        const workDir = input.workDir ? validateWorkspacePath(input.workDir as string) : undefined;
        const result = await provider.exec(sandboxId, args, { workDir, timeout: input.timeout as number | undefined });
        return { success: true, data: result };
      }
      case 'shell_session_create': {
        const handle = await provider.shellSessionCreate(sandboxId, {
          command: input.command as string[] | undefined,
          cwd: input.cwd ? validateWorkspacePath(input.cwd as string) : undefined,
          cols: input.cols as number | undefined,
          rows: input.rows as number | undefined,
        });
        await liveResourcesRepository.trackPtyCreated(
          { sandboxId, tenantId: call.tenantId, agentId: call.agentId, invocationId: call.invocationId },
          handle.sessionId,
        );
        return { success: true, data: { sessionId: handle.sessionId } };
      }
      case 'shell_session_write':
        await provider.shellSessionWrite(sandboxId, input.sessionId as string, input.data as string);
        return { success: true, data: {} };
      case 'shell_session_view': {
        const view = await provider.shellSessionView(sandboxId, input.sessionId as string, input.offset as number | undefined);
        return { success: true, data: view };
      }
      case 'shell_session_wait': {
        const result = await provider.shellSessionWait(sandboxId, input.sessionId as string, input.timeout_ms as number);
        return { success: true, data: result };
      }
      case 'shell_session_kill':
        await provider.shellSessionKill(sandboxId, input.sessionId as string);
        await liveResourcesRepository.trackPtyClosed(sandboxId, input.sessionId as string, null);
        return { success: true, data: {} };
      case 'shell_session_resize':
        await provider.shellSessionResize(sandboxId, input.sessionId as string, input.cols as number, input.rows as number);
        return { success: true, data: {} };
      case 'shell_session_cleanup':
        await provider.shellSessionCleanup(sandboxId, input.sessionId as string);
        await liveResourcesRepository.trackPtyClosed(sandboxId, input.sessionId as string, null);
        return { success: true, data: {} };
      case 'shell_session_cleanup_all': {
        await provider.shellSessionCleanupAll(sandboxId);
        // Bulk-close every active PTY for this sandbox in the observability
        // table so listing accurately reflects the post-cleanup state.
        const snapshots = await liveResourcesRepository.snapshot();
        const snap = snapshots.find(s => s.sandboxId === sandboxId);
        if (snap) {
          await Promise.all(
            snap.ptySessions.map((id: string) => liveResourcesRepository.trackPtyClosed(sandboxId, id, null)),
          );
        }
        return { success: true, data: {} };
      }
      case 'shell_session_stats': {
        const stats = await provider.shellSessionStats(sandboxId, input.sessionId as string);
        return { success: true, data: stats };
      }
      case 'shell_session_list': {
        const list = await provider.shellSessionList(sandboxId);
        return { success: true, data: list };
      }
      default:
        return { success: false, error: `unhandled tool: ${call.toolName}` };
    }
  },
};
