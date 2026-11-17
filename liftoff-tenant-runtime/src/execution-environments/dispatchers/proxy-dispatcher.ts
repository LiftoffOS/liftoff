import type { Dispatcher, DispatchInput, DispatchCtx, DispatchResult } from './types';

const SUPPORTED = new Set([
  'proxy_mapping_add',
  'proxy_mapping_remove',
  'proxy_mapping_list',
  'proxy_exclude_add',
  'proxy_exclude_remove',
  'proxy_exclude_list',
  'proxy_upstream_set',
  'proxy_upstream_remove',
  'proxy_upstream_get',
  'proxy_health',
  'proxy_diagnose',
]);

export const proxyDispatcher: Dispatcher = {
  supports: name => SUPPORTED.has(name),
  async handle(call: DispatchInput, ctx: DispatchCtx): Promise<DispatchResult> {
    const { provider } = ctx;
    const { sandboxId } = call;
    const input = call.input;
    switch (call.toolName) {
      case 'proxy_mapping_add':
        return { success: true, data: await provider.proxyMappingAdd(sandboxId, input.matchPattern as string, input.upstreamUrl as string) };
      case 'proxy_mapping_remove':
        await provider.proxyMappingRemove(sandboxId, input.mappingId as string);
        return { success: true, data: {} };
      case 'proxy_mapping_list':
        return { success: true, data: await provider.proxyMappingList(sandboxId) };
      case 'proxy_exclude_add':
        return { success: true, data: await provider.proxyExcludeAdd(sandboxId, input.pattern as string) };
      case 'proxy_exclude_remove':
        await provider.proxyExcludeRemove(sandboxId, input.excludeId as string);
        return { success: true, data: {} };
      case 'proxy_exclude_list':
        return { success: true, data: await provider.proxyExcludeList(sandboxId) };
      case 'proxy_upstream_set':
        await provider.proxyUpstreamSet(sandboxId, input.upstreamUrl as string);
        return { success: true, data: {} };
      case 'proxy_upstream_remove':
        await provider.proxyUpstreamRemove(sandboxId);
        return { success: true, data: {} };
      case 'proxy_upstream_get':
        return { success: true, data: await provider.proxyUpstreamGet(sandboxId) };
      case 'proxy_health':
        return { success: true, data: await provider.proxyHealth(sandboxId) };
      case 'proxy_diagnose':
        return { success: true, data: await provider.proxyDiagnose(sandboxId, input.url as string) };
      default:
        return { success: false, error: `unhandled tool: ${call.toolName}` };
    }
  },
};
