// The fence that would have caught migration 417 before it reached the migrate
// step. See scripts/ci-fences/migration-force-rls-fence.sh for the why.

import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const FENCE = path.join(__dirname, '..', 'ci-fences', 'migration-force-rls-fence.sh');

/** Runs the fence over a fixture directory. Returns its exit code and output. */
function runFence(dir: string): { code: number; out: string } {
  try {
    const out = execFileSync('bash', [FENCE, dir], { encoding: 'utf8' });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

describe('migration-force-rls-fence', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'force-fence-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const write = (name: string, sql: string) => fs.writeFile(path.join(dir, name), sql);

  it('flags an unguarded write to a FORCE table', async () => {
    await write('900_x.sql', "UPDATE internal_agents SET model_config = '{}'::jsonb WHERE id = '1';");

    const { code, out } = runFence(dir);
    expect(code).toBe(1);
    expect(out).toContain('internal_agents');
  });

  // 417 wrote two FORCE tables and the old fence saw neither. Both must report,
  // or fixing the first one hides the second.
  it('reports every FORCE table a migration writes, not just the first', async () => {
    await write('900_x.sql', [
      "UPDATE internal_agents SET updated_at = NOW();",
      "UPDATE model_configs SET updated_at = NOW();",
    ].join('\n'));

    const { code, out } = runFence(dir);
    expect(code).toBe(1);
    expect(out).toContain('internal_agents');
    expect(out).toContain('model_configs');
  });

  it('accepts a write wrapped in the NO FORCE escape', async () => {
    await write('900_x.sql', [
      'BEGIN;',
      'ALTER TABLE internal_agents NO FORCE ROW LEVEL SECURITY;',
      "UPDATE internal_agents SET updated_at = NOW();",
      'ALTER TABLE internal_agents FORCE ROW LEVEL SECURITY;',
      'COMMIT;',
    ].join('\n'));

    expect(runFence(dir).code).toBe(0);
  });

  // The escape has to name the table being written, not merely appear somewhere.
  it('does not let an escape on one table cover a write to another', async () => {
    await write('900_x.sql', [
      'ALTER TABLE internal_agents NO FORCE ROW LEVEL SECURITY;',
      "UPDATE internal_agents SET updated_at = NOW();",
      "UPDATE model_configs SET updated_at = NOW();",
      'ALTER TABLE internal_agents FORCE ROW LEVEL SECURITY;',
    ].join('\n'));

    const { code, out } = runFence(dir);
    expect(code).toBe(1);
    expect(out).toContain('model_configs');
    expect(out).not.toContain('writes internal_agents');
  });

  it('ignores tables that are RLS but not FORCE', async () => {
    // `models` carries no row-level security at all; 417 wrote it freely.
    await write('900_x.sql', "UPDATE models SET updated_at = NOW();");
    expect(runFence(dir).code).toBe(0);
  });

  it('ignores a table named only in a comment', async () => {
    await write('900_x.sql', '-- UPDATE internal_agents SET x = 1;\nSELECT 1;');
    expect(runFence(dir).code).toBe(0);
  });

  // Migrations at or below 287 ran before FORCE existed and can never run again.
  it('does not flag migrations from before FORCE was turned on', async () => {
    await write('200_x.sql', "UPDATE internal_agents SET updated_at = NOW();");
    expect(runFence(dir).code).toBe(0);
  });

  it('passes over the real migrations directory', () => {
    const { code, out } = runFence(path.join(__dirname, '..', '..', 'migrations'));
    expect(out).toContain('clean');
    expect(code).toBe(0);
  });
});
