import { browserContextRegistry } from './context';
import type { BrowserCookie } from '@liftoffos/sandbox-contracts';

export async function getCookies(tabId: string): Promise<{ cookies: BrowserCookie[] }> {
  const cookies = await browserContextRegistry.withPageLock(tabId, async page => page.context().cookies());
  return { cookies: cookies as BrowserCookie[] };
}

export async function setCookies(tabId: string, cookies: BrowserCookie[]): Promise<void> {
  await browserContextRegistry.withPageLock(tabId, async page => {
    await page.context().addCookies(cookies as Parameters<ReturnType<typeof page.context>['addCookies']>[0]);
  });
}

export async function clearCookies(tabId: string): Promise<void> {
  await browserContextRegistry.withPageLock(tabId, async page => page.context().clearCookies());
}
