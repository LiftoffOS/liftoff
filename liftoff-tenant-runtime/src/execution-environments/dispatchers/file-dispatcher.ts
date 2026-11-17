import { validateWorkspacePath } from '@liftoffos/sandbox-validators';
import { liveResourcesRepository } from '../live-resources-repository';
import type { Dispatcher, DispatchInput, DispatchCtx, DispatchResult } from './types';

const SUPPORTED = new Set([
  'file_read',
  'file_write',
  'file_replace',
  'file_str_replace_editor',
  'file_grep',
  'file_glob',
  'file_find',
  'file_watch_create',
  'file_watch_poll',
  'file_watch_stop',
]);

export const fileDispatcher: Dispatcher = {
  supports: name => SUPPORTED.has(name),
  async handle(call: DispatchInput, ctx: DispatchCtx): Promise<DispatchResult> {
    const { provider } = ctx;
    const { sandboxId } = call;
    const input = call.input;
    switch (call.toolName) {
      case 'file_read': {
        const content = await provider.readFile(sandboxId, validateWorkspacePath(input.path as string));
        return { success: true, data: { content } };
      }
      case 'file_write': {
        await provider.writeFile(sandboxId, validateWorkspacePath(input.path as string), input.content as string);
        return { success: true, data: {} };
      }
      case 'file_str_replace_editor': {
        const body = { ...input, path: validateWorkspacePath(input.path as string) } as Record<string, unknown>;
        const out = await provider.fileStrReplaceEditor(sandboxId, body);
        return { success: true, data: out };
      }
      case 'file_grep':
        return { success: true, data: await provider.fileGrep(sandboxId, { pattern: input.pattern as string, path: input.path as string | undefined, glob: input.glob as string | undefined }) };
      case 'file_glob':
        return { success: true, data: await provider.fileGlob(sandboxId, { pattern: input.pattern as string, root: input.root as string | undefined }) };
      case 'file_find':
        return { success: true, data: await provider.fileFind(sandboxId, { pattern: input.pattern as string, path: input.path as string | undefined, type: input.type as 'f' | 'd' | undefined }) };
      case 'file_watch_create': {
        const paths = input.paths as string[];
        const handle = await provider.fileWatchCreate(sandboxId, paths);
        await liveResourcesRepository.trackWatcherCreated(
          { sandboxId, tenantId: call.tenantId, agentId: call.agentId, invocationId: call.invocationId },
          handle.watcherId,
          paths,
        );
        return { success: true, data: { watcher_id: handle.watcherId } };
      }
      case 'file_watch_poll':
        return { success: true, data: await provider.fileWatchPoll(sandboxId, input.watcher_id as string, input.since as number | undefined) };
      case 'file_watch_stop':
        await provider.fileWatchStop(sandboxId, input.watcher_id as string);
        await liveResourcesRepository.trackWatcherStopped(sandboxId, input.watcher_id as string);
        return { success: true, data: {} };
      default:
        return { success: false, error: `unhandled tool: ${call.toolName}` };
    }
  },
};
