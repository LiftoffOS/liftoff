import { browserContextRegistry } from './context';
import { validateWorkspacePath } from '@liftoffos/sandbox-validators';

// Parse "Ctrl+Shift+P" → Playwright "Control+Shift+KeyP" style.
function parseHotKey(keys: string): string {
  const parts = keys.split('+').map(p => p.trim());
  const out: string[] = [];
  for (const p of parts) {
    const lower = p.toLowerCase();
    if (lower === 'ctrl' || lower === 'control') out.push('Control');
    else if (lower === 'cmd' || lower === 'meta') out.push('Meta');
    else if (lower === 'alt') out.push('Alt');
    else if (lower === 'shift') out.push('Shift');
    else out.push(p);
  }
  return out.join('+');
}

export async function hotKey(tabId: string, keys: string): Promise<void> {
  const parsed = parseHotKey(keys);
  await browserContextRegistry.withPageLock(tabId, async page => page.keyboard.press(parsed));
}

export async function uploadFile(tabId: string, selector: string, filePaths: string[]): Promise<void> {
  const validated = filePaths.map(p => validateWorkspacePath(p));
  await browserContextRegistry.withPageLock(tabId, async page => {
    await page.setInputFiles(selector, validated);
  });
}

export async function scrollTo(tabId: string, x: number, y: number): Promise<void> {
  await browserContextRegistry.withPageLock(tabId, async page => {
    await page.evaluate(([xx, yy]) => window.scrollTo(xx, yy), [x, y] as [number, number]);
  });
}

export async function scrollToElement(tabId: string, selector: string): Promise<void> {
  await browserContextRegistry.withPageLock(tabId, async page => {
    await page.locator(selector).first().scrollIntoViewIfNeeded();
  });
}
