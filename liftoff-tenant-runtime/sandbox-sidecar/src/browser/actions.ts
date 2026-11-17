import { browserContextRegistry } from './context';

export async function navigate(tabIdOrUndefined: string | undefined, url: string, waitUntil: 'load' | 'domcontentloaded' | 'networkidle' = 'load', timeoutMs = 30_000): Promise<{ tabId: string; data: { url: string } }> {
  let tabId = tabIdOrUndefined;
  if (!tabId) {
    const tabs = browserContextRegistry.listTabs();
    if (tabs.length > 0) {
      tabId = tabs[0].tabId;
    } else {
      const opened = await browserContextRegistry.openPage();
      tabId = opened.tabId;
    }
  }
  const finalTabId = tabId!;
  await browserContextRegistry.withPageLock(finalTabId, async page => {
    await page.goto(url, { waitUntil, timeout: Math.min(timeoutMs, 60_000) });
  });
  return { tabId: finalTabId, data: { url } };
}

export async function click(tabId: string, selector: string): Promise<void> {
  await browserContextRegistry.withPageLock(tabId, async page => page.click(selector));
}

export async function fill(tabId: string, selector: string, value: string): Promise<void> {
  await browserContextRegistry.withPageLock(tabId, async page => page.fill(selector, value));
}

export async function type(tabId: string, selector: string, value: string): Promise<void> {
  await browserContextRegistry.withPageLock(tabId, async page => page.type(selector, value));
}

export async function pressKey(tabId: string, key: string): Promise<void> {
  await browserContextRegistry.withPageLock(tabId, async page => page.keyboard.press(key));
}

export async function hover(tabId: string, selector: string): Promise<void> {
  await browserContextRegistry.withPageLock(tabId, async page => page.hover(selector));
}

export async function selectOption(tabId: string, selector: string, value: string): Promise<void> {
  await browserContextRegistry.withPageLock(tabId, async page => {
    await page.selectOption(selector, value);
  });
}

export async function check(tabId: string, selector: string): Promise<void> {
  await browserContextRegistry.withPageLock(tabId, async page => page.check(selector));
}

export async function uncheck(tabId: string, selector: string): Promise<void> {
  await browserContextRegistry.withPageLock(tabId, async page => page.uncheck(selector));
}

export async function scroll(tabId: string, dx: number, dy: number): Promise<void> {
  await browserContextRegistry.withPageLock(tabId, async page => {
    await page.evaluate(([x, y]) => window.scrollBy(x, y), [dx, dy] as [number, number]);
  });
}

export async function waitFor(tabId: string, selector: string, timeoutMs: number): Promise<void> {
  await browserContextRegistry.withPageLock(tabId, async page => {
    await page.waitForSelector(selector, { timeout: timeoutMs });
  });
}

export async function evaluate(tabId: string, script: string): Promise<unknown> {
  return browserContextRegistry.withPageLock(tabId, async page => page.evaluate(script));
}
