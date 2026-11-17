// The fence behind INV-PB-014: an MCP credential is revoked one person at a
// time, never by a script, a migration or a release. See
// scripts/ci-fences/credential-revocation-fence.sh for the why.

import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const FENCE = path.join(__dirname, '..', 'ci-fences', 'credential-revocation-fence.sh');

function runFence(root: string): { code: number; out: string } {
  try {
    const out = execFileSync('bash', [FENCE, path.join(root, 'src'), path.join(root, 'migrations')], { encoding: 'utf8' });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: (err.stdout ?? '') + (err.stderr ?? '') };
  }
}

describe('credential-revocation-fence', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cred-fence-'));
    await fs.mkdir(path.join(root, 'src', 'scripts'), { recursive: true });
    await fs.mkdir(path.join(root, 'src', 'oauth'), { recursive: true });
    await fs.mkdir(path.join(root, 'migrations'), { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const write = (rel: string, body: string) => fs.writeFile(path.join(root, rel), body);

  it('is clean when every revocation is bound to one grant, token or person', async () => {
    await write('src/oauth/revoke.ts', [
      'const a = `UPDATE oauth_access_tokens SET revoked_at = NOW() WHERE grant_id = $1 AND revoked_at IS NULL`;',
      'const b = `UPDATE mcp_tokens SET status = \'revoked\', deleted_at = NOW() WHERE id = $1`;',
      // The revoke route rotates between two tables; the interpolated name is
      // checked like a named one and passes on its parameter.
      'const c = `UPDATE ${table} t SET revoked_at = NOW() FROM oauth_grants g WHERE t.token_hash = $1 AND g.id = t.grant_id`;',
    ].join('\n'));
    await write('migrations/900_x.sql', "-- prose: mcp_tokens status = 'revoked'\nALTER TABLE mcp_tokens ADD COLUMN IF NOT EXISTS note TEXT;\n");

    const { code, out } = runFence(root);
    expect(code).toBe(0);
    expect(out).toContain('clean');
  });

  it('fails a script that revokes credentials, whatever its WHERE clause', async () => {
    await write('src/scripts/revoke-everything.ts', 'await client.query(`UPDATE oauth_refresh_tokens SET revoked_at = NOW() WHERE tenant_id = $1`);\n');

    const { code, out } = runFence(root);
    expect(code).toBe(1);
    expect(out).toContain('src/scripts/revoke-everything.ts');
    expect(out).toContain('script or migration');
  });

  it('fails a migration that revokes credentials', async () => {
    await write('migrations/901_revoke.sql', "UPDATE oauth_grants SET status = 'revoked', revoked_at = NOW() WHERE status = 'active';\n");

    const { code, out } = runFence(root);
    expect(code).toBe(1);
    expect(out).toContain('migrations/901_revoke.sql');
  });

  it('fails an unbounded revocation anywhere else in src', async () => {
    await write('src/oauth/sweep.ts', 'const q = `UPDATE oauth_access_tokens SET revoked_at = NOW() WHERE revoked_at IS NULL`;\n');

    const { code, out } = runFence(root);
    expect(code).toBe(1);
    expect(out).toContain('src/oauth/sweep.ts');
    expect(out).toContain('no bound parameter');
  });

  it('ignores revocations on tables that are not credentials', async () => {
    await write('src/oauth/push.ts', 'const q = `UPDATE push_subscriptions SET revoked_at = NOW() WHERE revoked_at IS NULL`;\n');

    const { code } = runFence(root);
    expect(code).toBe(0);
  });
});
