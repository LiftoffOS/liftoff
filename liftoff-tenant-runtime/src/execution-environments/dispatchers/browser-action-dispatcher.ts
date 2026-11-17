import { liveResourcesRepository } from '../live-resources-repository';
import { frameUntrusted } from '../../workspace/untrusted-content-wrapper';
import { isUuid } from '../../agent-execution/run-identity';
import type { Dispatcher, DispatchInput, DispatchCtx, DispatchResult } from './types';

const SUPPORTED = new Set([
  'browser_navigate',
  'browser_click',
  'browser_fill',
  'browser_type',
  'browser_press_key',
  'browser_hover',
  'browser_select_option',
  'browser_check',
  'browser_uncheck',
  'browser_scroll',
  'browser_wait_for',
  'browser_evaluate',
  'browser_screenshot',
  'browser_extract_text',
  'browser_extract_markdown',
  'browser_extract_html',
  'browser_list_tabs',
  'browser_new_tab',
  'browser_close_tab',
  'browser_back',
  'browser_forward',
  'browser_reload',
  'browser_hot_key',
  'browser_upload_file',
  'browser_get_elements',
  'browser_get_console',
  'browser_export_console',
  'browser_find_text',
  'browser_scroll_to',
  'browser_scroll_to_element',
]);

/** Frame one extraction's text, with the screen every framed source gets.
 *  Empty stays empty: a frame around nothing is a non-empty string, and a
 *  caller reading "did this page have any text" would see one. */
function framePageText(call: DispatchInput, text: string): string {
  if (!text) return text;
  // `call.invocationId` is the sandbox-domain handle, which is sometimes a
  // composite `sandbox:<id>:<tool>:<seq>` string rather than a real invocation.
  // The screen's audit row lands in audit_logs, whose invocation_id is a uuid
  // with an FK, so only a well-formed one travels; otherwise the screen runs
  // undeduplicated, which is the stated fallback.
  return frameUntrusted(`browser:${call.toolName}`, text, undefined, {
    tenantId: call.tenantId,
    agentId: call.agentId,
    ...(isUuid(call.invocationId) ? { invocationId: call.invocationId } : {}),
    placement: 'tool_result',
  });
}

export const browserActionDispatcher: Dispatcher = {
  supports: name => SUPPORTED.has(name),
  async handle(call: DispatchInput, ctx: DispatchCtx): Promise<DispatchResult> {
    const { provider } = ctx;
    const { sandboxId } = call;
    const input = call.input;
    const tabId = input.tabId as string | undefined;
    switch (call.toolName) {
      case 'browser_navigate': {
        const result = await provider.browserNavigate(sandboxId, tabId, input.url as string);
        // Navigate may implicitly open a new tab when tabId was undefined.
        // Track it either way so the lifetime ticker sees the live tab.
        await liveResourcesRepository.trackBrowserTabOpened(
          { sandboxId, tenantId: call.tenantId, agentId: call.agentId, invocationId: call.invocationId },
          result.tabId,
          input.url as string,
        );
        return { success: result.success, data: result.data ?? { tabId: result.tabId } };
      }
      case 'browser_click':
        return { success: true, data: await provider.browserClick(sandboxId, tabId!, input.selector as string) };
      case 'browser_fill':
        return { success: true, data: await provider.browserFill(sandboxId, tabId!, input.selector as string, input.value as string) };
      case 'browser_type':
        return { success: true, data: await provider.browserType(sandboxId, tabId!, input.selector as string, input.value as string) };
      case 'browser_press_key':
        return { success: true, data: await provider.browserPressKey(sandboxId, tabId!, input.key as string) };
      case 'browser_hover':
        return { success: true, data: await provider.browserHover(sandboxId, tabId!, input.selector as string) };
      case 'browser_select_option':
        return { success: true, data: await provider.browserSelectOption(sandboxId, tabId!, input.selector as string, input.value as string) };
      case 'browser_check':
        return { success: true, data: await provider.browserCheck(sandboxId, tabId!, input.selector as string) };
      case 'browser_uncheck':
        return { success: true, data: await provider.browserUncheck(sandboxId, tabId!, input.selector as string) };
      case 'browser_scroll':
        return { success: true, data: await provider.browserScroll(sandboxId, tabId!, input.dx as number, input.dy as number) };
      case 'browser_wait_for':
        return { success: true, data: await provider.browserWaitFor(sandboxId, tabId!, input.selector as string, input.timeout_ms as number) };
      case 'browser_evaluate': {
        const r = await provider.browserEvaluate(sandboxId, tabId!, input.script as string);
        return { success: true, data: { result: r.result } };
      }
      case 'browser_screenshot': {
        const r = await provider.browserScreenshot(sandboxId, tabId!, input.selector as string | undefined);
        return { success: true, data: { png_base64: r.pngBase64 } };
      }
      // The three extractions are a page's own bytes on their way into the
      // model, which is exactly what the file-read path beside them already
      // frames (execution-environments/sandbox-executor.ts). Each carries one
      // text field, named differently per variant, so each is framed in place
      // and the surrounding object keeps its shape.
      case 'browser_extract_text': {
        const r = await provider.browserExtractText(sandboxId, tabId!, input.selector as string | undefined);
        return { success: true, data: { ...r, text: framePageText(call, r.text) } };
      }
      case 'browser_extract_markdown': {
        const r = await provider.browserExtractMarkdown(sandboxId, tabId!);
        return { success: true, data: { ...r, markdown: framePageText(call, r.markdown) } };
      }
      case 'browser_extract_html': {
        const r = await provider.browserExtractHtml(sandboxId, tabId!);
        return { success: true, data: { ...r, html: framePageText(call, r.html) } };
      }
      case 'browser_list_tabs':
        return { success: true, data: await provider.browserListTabs(sandboxId) };
      case 'browser_new_tab': {
        const handle = await provider.browserNewTab(sandboxId);
        await liveResourcesRepository.trackBrowserTabOpened(
          { sandboxId, tenantId: call.tenantId, agentId: call.agentId, invocationId: call.invocationId },
          handle.tabId,
          null,
        );
        return { success: true, data: handle };
      }
      case 'browser_close_tab':
        await provider.browserCloseTab(sandboxId, tabId!);
        await liveResourcesRepository.trackBrowserTabClosed(sandboxId, tabId!);
        return { success: true, data: {} };
      case 'browser_back':
        await provider.browserBack(sandboxId, tabId!);
        return { success: true, data: {} };
      case 'browser_forward':
        await provider.browserForward(sandboxId, tabId!);
        return { success: true, data: {} };
      case 'browser_reload':
        await provider.browserReload(sandboxId, tabId!, input.wait_until as 'load' | 'domcontentloaded' | 'networkidle' | undefined);
        return { success: true, data: {} };
      case 'browser_hot_key':
        await provider.browserHotKey(sandboxId, tabId!, input.keys as string);
        return { success: true, data: {} };
      case 'browser_upload_file':
        await provider.browserUploadFile(sandboxId, tabId!, input.selector as string, input.filePaths as string[]);
        return { success: true, data: {} };
      case 'browser_get_elements':
        return { success: true, data: await provider.browserGetElements(sandboxId, tabId!, input.selector as string) };
      case 'browser_get_console':
        return { success: true, data: await provider.browserGetConsole(sandboxId, tabId!, input.since as number | undefined) };
      case 'browser_export_console':
        return { success: true, data: await provider.browserExportConsole(sandboxId, tabId!) };
      case 'browser_find_text':
        return { success: true, data: await provider.browserFindText(sandboxId, tabId!, input.text as string) };
      case 'browser_scroll_to':
        await provider.browserScrollTo(sandboxId, tabId!, input.x as number, input.y as number);
        return { success: true, data: {} };
      case 'browser_scroll_to_element':
        await provider.browserScrollToElement(sandboxId, tabId!, input.selector as string);
        return { success: true, data: {} };
      default:
        return { success: false, error: `unhandled tool: ${call.toolName}` };
    }
  },
};
