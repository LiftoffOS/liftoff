// Per-page video recording.
// Playwright records video at the BrowserContext level. The registry owns
// context creation (createNamedContext + closeContext), so we only invoke
// the registry's narrow API — we never touch the raw Browser handle.

import { promises as fs } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { browserContextRegistry } from './context';

const RECORD_DIR = '/workspace/.browser-recordings';

interface RecordingState {
  tabId: string;
  contextId: string;
  dir: string;
}

const active = new Map<string, RecordingState>();

async function ensureRecordDir(): Promise<void> {
  await fs.mkdir(RECORD_DIR, { recursive: true });
}

/**
 * Start a new recording. The registry creates an isolated context with
 * Playwright's recordVideo option and returns the tabId; we navigate it
 * (optionally) and remember the context id so stopRecording can close it.
 */
export async function startRecording(url?: string): Promise<{ tabId: string; recordingId: string }> {
  await ensureRecordDir();
  const recordingId = randomUUID();
  const dir = join(RECORD_DIR, recordingId);
  await fs.mkdir(dir, { recursive: true });
  const contextId = `record-${recordingId}`;

  const { tabId } = await browserContextRegistry.createNamedContext(contextId, {
    recordVideo: { dir, size: { width: 1280, height: 720 } },
    viewport: { width: 1280, height: 720 },
  });

  if (url) {
    await browserContextRegistry.navigateInTab(tabId, url, 'load', 30_000);
  }
  active.set(tabId, { tabId, contextId, dir });
  return { tabId, recordingId };
}

/**
 * Stop recording on a tab. The registry's closeContext flushes the .webm.
 */
export async function stopRecording(tabId: string): Promise<{ outputPath: string }> {
  const rec = active.get(tabId);
  if (!rec) throw new Error('no active recording for tab');

  await browserContextRegistry.closeContext(rec.contextId);

  const files = await fs.readdir(rec.dir).catch(() => [] as string[]);
  const webm = files.find(f => f.endsWith('.webm'));
  active.delete(tabId);
  return { outputPath: webm ? join(rec.dir, webm) : rec.dir };
}

export function listRecordings(): Array<{ tabId: string; recordingId: string; dir: string }> {
  return Array.from(active.values()).map(r => ({
    tabId: r.tabId,
    recordingId: r.contextId.replace(/^record-/, ''),
    dir: r.dir,
  }));
}
