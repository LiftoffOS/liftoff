import { browserContextRegistry } from './context';

export async function listTabs(): Promise<{ tabs: Array<{ tabId: string; url: string; title: string }> }> {
  const tabs = await Promise.all(
    browserContextRegistry.listTabs().map(async t => {
      const title = await browserContextRegistry.withPageLock(t.tabId, async page => page.title()).catch(() => '');
      return { ...t, title };
    }),
  );
  return { tabs };
}

export async function newTab(): Promise<{ tabId: string }> {
  const { tabId } = await browserContextRegistry.openPage();
  return { tabId };
}

export async function closeTab(tabId: string): Promise<void> {
  await browserContextRegistry.closeTab(tabId);
}

export async function switchTab(_tabId: string): Promise<void> {
  // Playwright doesn't have a "focused tab" concept; tabs are addressed by id.
  // No-op preserved for parity surface.
}
