import type { Dispatcher, DispatchInput, DispatchCtx, DispatchResult } from './types';

const SUPPORTED = new Set(['util_convert_to_markdown']);

export const utilDispatcher: Dispatcher = {
  supports: name => SUPPORTED.has(name),
  async handle(call: DispatchInput, ctx: DispatchCtx): Promise<DispatchResult> {
    if (call.toolName !== 'util_convert_to_markdown') return { success: false, error: 'unhandled' };
    const input = call.input;
    const data = await ctx.provider.utilConvertToMarkdown(call.sandboxId, {
      path: input.path as string | undefined,
      content: input.content as string | undefined,
      mime: input.mime as string | undefined,
    });
    return { success: true, data };
  },
};
