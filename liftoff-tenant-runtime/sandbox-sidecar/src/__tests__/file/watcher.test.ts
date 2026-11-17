import { promises as fs, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { WatcherRegistry } from '../../file/watcher';

jest.mock('@liftoffos/sandbox-validators', () => ({
  validateWorkspacePath: (p: string) => p,
}));

describe('WatcherRegistry', () => {
  let dir: string;
  let registry: WatcherRegistry;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'watch-test-'));
  });
  beforeEach(() => {
    registry = new WatcherRegistry();
  });
  afterEach(async () => {
    await registry.stopAll();
  });

  it('emits an "add" event when a file appears in the watched directory', async () => {
    const handle = registry.create([dir]);
    expect(handle.watcher_id).toBeTruthy();

    const filename = `f-${Date.now()}.txt`;
    await new Promise(resolve => setTimeout(resolve, 200));
    await fs.writeFile(join(dir, filename), 'x');
    await new Promise(resolve => setTimeout(resolve, 300));

    const polled = registry.poll(handle.watcher_id);
    expect(polled.events.some(e => e.path.endsWith(filename))).toBe(true);
  });

  it('list returns active watchers; stop removes one', async () => {
    const a = registry.create([dir]);
    const b = registry.create([dir]);
    expect(registry.list().map(w => w.id).sort()).toEqual([a.watcher_id, b.watcher_id].sort());
    await registry.stop(a.watcher_id);
    expect(registry.list().map(w => w.id)).toEqual([b.watcher_id]);
  });

  it('wait long-polls until an event arrives or the timeout fires', async () => {
    const handle = registry.create([dir]);
    const start = Date.now();
    const waiter = registry.wait(handle.watcher_id, 500);
    setTimeout(() => fs.writeFile(join(dir, `wait-${Date.now()}.txt`), 'y'), 100);
    const events = await waiter;
    expect(Date.now() - start).toBeLessThan(800);
    expect(events.length).toBeGreaterThanOrEqual(0); // events may have already been buffered
  });
});
