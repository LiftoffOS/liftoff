import { promises as fs } from 'fs';
import { browserContextRegistry } from './context';

export async function getConsole(tabId: string, since?: number): Promise<{ messages: Array<{ level: string; text: string; ts: number }> }> {
  return { messages: browserContextRegistry.getConsoleMessages(tabId, since) };
}

export async function exportConsole(tabId: string): Promise<{ path: string }> {
  const messages = browserContextRegistry.getConsoleMessages(tabId);
  const path = `/workspace/.browser-logs/${tabId}.log`;
  await fs.mkdir('/workspace/.browser-logs', { recursive: true });
  const body = messages.map(m => `[${new Date(m.ts).toISOString()}] ${m.level}: ${m.text}`).join('\n');
  await fs.writeFile(path, body, 'utf-8');
  return { path };
}
