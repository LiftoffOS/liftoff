import type { Dispatcher, DispatchInput, DispatchCtx, DispatchResult } from './types';

const SUPPORTED = new Set([
  'sandbox_context',
  'sandbox_list_python_packages',
  'sandbox_list_nodejs_packages',
  'sandbox_restart',
  'vscode_get_url',
]);

export const sandboxMetaDispatcher: Dispatcher = {
  supports: name => SUPPORTED.has(name),
  async handle(call: DispatchInput, ctx: DispatchCtx): Promise<DispatchResult> {
    const { provider } = ctx;
    const { sandboxId } = call;
    switch (call.toolName) {
      case 'sandbox_context':
        return { success: true, data: await provider.getSandboxContext(sandboxId) };
      case 'sandbox_list_python_packages':
        return { success: true, data: await provider.listPythonPackages(sandboxId) };
      case 'sandbox_list_nodejs_packages':
        return { success: true, data: await provider.listNodejsPackages(sandboxId) };
      case 'sandbox_restart':
        return { success: true, data: await provider.restartSandbox(sandboxId) };
      case 'vscode_get_url': {
        const info = await provider.getSandboxInfo(sandboxId);
        return { success: true, data: { url: info.vscodeUrl } };
      }
      default:
        return { success: false, error: `unhandled tool: ${call.toolName}` };
    }
  },
};
