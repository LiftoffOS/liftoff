import chokidar, { type FSWatcher } from 'chokidar';
import { randomUUID } from 'crypto';
import { validateWorkspacePath } from '@liftoffos/sandbox-validators';
import { WatcherNotFoundError } from '../shared/errors';
import type { FileWatchEvent } from '@liftoffos/sandbox-contracts';

interface WatcherEntry {
  id: string;
  paths: string[];
  watcher: FSWatcher;
  events: FileWatchEvent[];
  createdAt: number;
  waiters: Array<{ resolve: (evs: FileWatchEvent[]) => void; timer: NodeJS.Timeout }>;
  sseClients: Array<(evt: FileWatchEvent) => void>;
}

const EVENT_BUFFER = 1000;

export class WatcherRegistry {
  private watchers = new Map<string, WatcherEntry>();

  create(paths: string[]): { watcher_id: string } {
    const resolved = paths.map(p => validateWorkspacePath(p));
    const id = randomUUID();
    const watcher = chokidar.watch(resolved, {
      ignored: [/\.git/, /node_modules/, /\.venv/],
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
      usePolling: false,
      alwaysStat: false,
    });
    const entry: WatcherEntry = {
      id,
      paths: resolved,
      watcher,
      events: [],
      createdAt: Date.now(),
      waiters: [],
      sseClients: [],
    };
    const pushEvent = (type: 'add' | 'change' | 'unlink') => (path: string) => {
      const evt: FileWatchEvent = { type, path, ts: Date.now() };
      entry.events.push(evt);
      while (entry.events.length > EVENT_BUFFER) entry.events.shift();
      for (const sseSub of entry.sseClients) sseSub(evt);
      for (const w of entry.waiters.splice(0)) {
        clearTimeout(w.timer);
        w.resolve([evt]);
      }
    };
    watcher.on('add', pushEvent('add'));
    watcher.on('change', pushEvent('change'));
    watcher.on('unlink', pushEvent('unlink'));
    this.watchers.set(id, entry);
    return { watcher_id: id };
  }

  poll(id: string, since?: number): { events: FileWatchEvent[] } {
    const entry = this.watchers.get(id);
    if (!entry) throw new WatcherNotFoundError();
    return { events: entry.events.filter(e => (since ? e.ts > since : true)) };
  }

  async wait(id: string, timeoutMs: number): Promise<FileWatchEvent[]> {
    const entry = this.watchers.get(id);
    if (!entry) throw new WatcherNotFoundError();
    return new Promise<FileWatchEvent[]>(resolve => {
      const timer = setTimeout(() => {
        const i = entry.waiters.findIndex(w => w.timer === timer);
        if (i >= 0) entry.waiters.splice(i, 1);
        resolve([]);
      }, Math.min(timeoutMs, 60_000));
      entry.waiters.push({ resolve, timer });
    });
  }

  subscribe(id: string, cb: (evt: FileWatchEvent) => void): () => void {
    const entry = this.watchers.get(id);
    if (!entry) throw new WatcherNotFoundError();
    entry.sseClients.push(cb);
    return () => {
      const i = entry.sseClients.indexOf(cb);
      if (i >= 0) entry.sseClients.splice(i, 1);
    };
  }

  list(): Array<{ id: string; paths: string[]; created_at: string }> {
    return Array.from(this.watchers.values()).map(e => ({
      id: e.id,
      paths: e.paths,
      created_at: new Date(e.createdAt).toISOString(),
    }));
  }

  async stop(id: string): Promise<void> {
    const entry = this.watchers.get(id);
    if (!entry) return;
    await entry.watcher.close();
    this.watchers.delete(id);
  }

  async stopAll(): Promise<void> {
    for (const id of Array.from(this.watchers.keys())) await this.stop(id);
  }
}

export const watcherRegistry = new WatcherRegistry();
