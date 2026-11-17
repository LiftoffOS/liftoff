import { browserContextRegistry } from './context';

export async function screenshot(tabId: string, selector?: string): Promise<{ pngBase64: string }> {
  const buf = await browserContextRegistry.withPageLock(tabId, async page => {
    if (selector) {
      return page.locator(selector).first().screenshot({ type: 'png' });
    }
    return page.screenshot({ type: 'png' });
  });
  return { pngBase64: buf.toString('base64') };
}
