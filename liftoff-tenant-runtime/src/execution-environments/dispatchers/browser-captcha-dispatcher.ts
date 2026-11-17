import type { Dispatcher, DispatchInput, DispatchCtx, DispatchResult } from './types';

const SUPPORTED = new Set(['browser_captcha_detect', 'browser_captcha_wait']);

export const browserCaptchaDispatcher: Dispatcher = {
  supports: name => SUPPORTED.has(name),
  async handle(call: DispatchInput, ctx: DispatchCtx): Promise<DispatchResult> {
    const { provider } = ctx;
    const { sandboxId } = call;
    const input = call.input;
    if (call.toolName === 'browser_captcha_detect') {
      return { success: true, data: await provider.browserCaptchaDetect(sandboxId, input.tabId as string) };
    }
    if (call.toolName === 'browser_captcha_wait') {
      return { success: true, data: await provider.browserCaptchaWait(sandboxId, input.tabId as string, input.timeoutMs as number | undefined) };
    }
    return { success: false, error: `unhandled tool: ${call.toolName}` };
  },
};
