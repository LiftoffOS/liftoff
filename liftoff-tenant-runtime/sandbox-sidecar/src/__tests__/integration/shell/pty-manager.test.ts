import { PtyManager } from '../../shell/pty-manager';

describe('PtyManager', () => {
  let manager: PtyManager;
  beforeEach(() => {
    manager = new PtyManager();
  });
  afterEach(async () => {
    await manager.killAll();
  });

  it('creates a session and returns a usable handle', () => {
    const session = manager.create({ command: ['echo', 'hi'] });
    expect(session.sessionId).toMatch(/[0-9a-f-]{30,}/);
  });

  it('list() reflects create + destroy lifecycle', () => {
    const a = manager.create({ command: ['echo', 'a'] });
    const b = manager.create({ command: ['echo', 'b'] });
    const ids = manager.list().map(s => s.sessionId).sort();
    expect(ids).toEqual([a.sessionId, b.sessionId].sort());
    manager.destroy(a.sessionId);
    expect(manager.list()).toHaveLength(1);
  });

  it('throws SessionNotFoundError on unknown id', () => {
    expect(() => manager.get('unknown')).toThrow(/session/);
  });

  it('view returns content with a cursor and supports offset polling', async () => {
    const session = manager.create({ command: ['bash', '-c', 'echo hello'] });
    await new Promise(resolve => setTimeout(resolve, 200));
    const view = session.view(0);
    expect(view.content).toContain('hello');
    expect(view.cursor).toBeGreaterThanOrEqual(view.content.length);
  });

  it('stats reports active vs exited', async () => {
    const session = manager.create({ command: ['bash', '-c', 'true'] });
    await session.waitForExit(2000);
    expect(session.stats().status).toBe('exited');
    expect(typeof session.stats().exitCode).toBe('number');
  });
});
