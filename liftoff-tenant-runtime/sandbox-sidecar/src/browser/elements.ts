import { browserContextRegistry } from './context';

export async function getElements(tabId: string, selector: string): Promise<{ elements: Array<{ tag: string; text: string; attrs: Record<string, string> }> }> {
  return browserContextRegistry.withPageLock(tabId, async page => {
    const locator = page.locator(selector);
    const count = await locator.count();
    const elements: Array<{ tag: string; text: string; attrs: Record<string, string> }> = [];
    for (let i = 0; i < count; i++) {
      const el = locator.nth(i);
      const evaluated = await el.evaluate(node => {
        const attrs: Record<string, string> = {};
        for (const a of Array.from((node as Element).attributes)) attrs[a.name] = a.value;
        return { tag: (node as Element).tagName.toLowerCase(), text: (node.textContent ?? '').trim(), attrs };
      });
      elements.push(evaluated);
    }
    return { elements };
  });
}

export async function findText(tabId: string, text: string): Promise<{ found: boolean; selector?: string; bounding_box?: { x: number; y: number; width: number; height: number } }> {
  return browserContextRegistry.withPageLock(tabId, async page => {
    const locator = page.getByText(text).first();
    const exists = (await locator.count()) > 0;
    if (!exists) return { found: false };
    const box = await locator.boundingBox();
    return {
      found: true,
      selector: `text="${text}"`,
      bounding_box: box ? { x: box.x, y: box.y, width: box.width, height: box.height } : undefined,
    };
  });
}
