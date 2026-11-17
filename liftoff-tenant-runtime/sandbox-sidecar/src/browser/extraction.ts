import { browserContextRegistry } from './context';

export async function extractHtml(tabId: string): Promise<{ html: string }> {
  const html = await browserContextRegistry.withPageLock(tabId, async page => page.content());
  return { html };
}

export async function extractText(tabId: string, selector?: string): Promise<{ text: string }> {
  const text = await browserContextRegistry.withPageLock(tabId, async page => {
    if (selector) return (await page.locator(selector).innerText()) ?? '';
    return (await page.locator('body').innerText()) ?? '';
  });
  return { text };
}

export async function extractMarkdown(tabId: string): Promise<{ markdown: string }> {
  // Lightweight HTML→Markdown via inline conversion; for richer output, callers can pipe
  // browser_extract_html → util/convertToMarkdown.
  const html = await browserContextRegistry.withPageLock(tabId, async page => page.content());
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/g, '')
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return { markdown: stripped };
}
