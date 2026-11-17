import { promises as fs } from 'fs';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { browserContextRegistry } from './context';
import { FileTooLargeError } from '../shared/errors';

const STATE_DIR = '/workspace/.browser-state';
const MAX_STATE_BYTES = 10 * 1024 * 1024;

export async function saveState(tabId: string, stateId?: string): Promise<{ stateId: string; path: string }> {
  const id = stateId ?? randomUUID();
  const path = join(STATE_DIR, `${id}.json`);
  await fs.mkdir(STATE_DIR, { recursive: true });
  await browserContextRegistry.withPageLock(tabId, async page => {
    const state = await page.context().storageState();
    const json = JSON.stringify(state);
    if (json.length > MAX_STATE_BYTES) {
      throw new FileTooLargeError(MAX_STATE_BYTES);
    }
    await fs.writeFile(path, json, 'utf-8');
  });
  return { stateId: id, path };
}

export async function loadState(stateId: string): Promise<{ tabId: string }> {
  const path = join(STATE_DIR, `${stateId}.json`);
  await fs.access(path);
  // The registry owns chromium context creation — we pass the storageState
  // path as a Playwright option and the registry handles `browser.newContext`
  // under its mutex, so we never touch the Browser handle directly.
  return browserContextRegistry.createNamedContext(`state-${stateId}`, { storageState: path });
}

export async function listStates(): Promise<{ states: Array<{ stateId: string; createdAt: string; size: number }> }> {
  await fs.mkdir(STATE_DIR, { recursive: true });
  const items = await fs.readdir(STATE_DIR);
  const states: Array<{ stateId: string; createdAt: string; size: number }> = [];
  for (const item of items) {
    if (!item.endsWith('.json')) continue;
    const full = join(STATE_DIR, item);
    const stat = await fs.stat(full);
    states.push({ stateId: item.slice(0, -'.json'.length), createdAt: stat.mtime.toISOString(), size: stat.size });
  }
  return { states };
}

export async function deleteState(stateId: string): Promise<void> {
  const path = join(STATE_DIR, `${stateId}.json`);
  await fs.unlink(path).catch(() => undefined);
}
