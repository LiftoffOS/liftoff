import type { Dispatcher, DispatchInput, DispatchCtx, DispatchResult } from './types';

const SUPPORTED = new Set([
  'browser_route_add',
  'browser_route_remove',
  'browser_route_list',
  'browser_headers_set',
  'browser_headers_scoped',
  'browser_headers_clear',
  'browser_requests_list',
]);

export const browserNetworkDispatcher: Dispatcher = {
  supports: name => SUPPORTED.has(name),
  async handle(call: DispatchInput, ctx: DispatchCtx): Promise<DispatchResult> {
    const { provider } = ctx;
    const { sandboxId } = call;
    const input = call.input;
    switch (call.toolName) {
      case 'browser_route_add':
        return { success: true, data: await provider.browserRouteAdd(sandboxId, input.tabId as string, input.urlPattern as string, input.action as 'block' | 'fulfill' | 'continue', input.fulfill as { status: number; body: string; headers: Record<string, string> } | undefined) };
      case 'browser_route_remove':
        await provider.browserRouteRemove(sandboxId, input.routeId as string);
        return { success: true, data: {} };
      case 'browser_route_list':
        return { success: true, data: await provider.browserRouteList(sandboxId) };
      case 'browser_headers_set':
        await provider.browserHeadersSet(sandboxId, input.tabId as string, input.headers as Record<string, string>);
        return { success: true, data: {} };
      case 'browser_headers_scoped':
        return { success: true, data: await provider.browserHeadersScoped(sandboxId, input.tabId as string, input.urlPattern as string, input.headers as Record<string, string>) };
      case 'browser_headers_clear':
        await provider.browserHeadersClear(sandboxId, input.tabId as string);
        return { success: true, data: {} };
      case 'browser_requests_list':
        return { success: true, data: await provider.browserRequestsList(sandboxId, input.tabId as string, input.since as number | undefined) };
      default:
        return { success: false, error: `unhandled tool: ${call.toolName}` };
    }
  },
};
