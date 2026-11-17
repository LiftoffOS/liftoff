import { browserContextRegistry } from './context';

export async function back(tabId: string): Promise<void> {
  await browserContextRegistry.withPageLock(tabId, async page => {
    await page.goBack();
  });
}

export async function forward(tabId: string): Promise<void> {
  await browserContextRegistry.withPageLock(tabId, async page => {
    await page.goForward();
  });
}

export async function reload(tabId: string, waitUntil: 'load' | 'domcontentloaded' | 'networkidle' = 'load'): Promise<void> {
  await browserContextRegistry.withPageLock(tabId, async page => {
    await page.reload({ waitUntil });
  });
}
