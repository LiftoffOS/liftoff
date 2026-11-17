// C.1 — Meta-test: the harness CLI MUST exit non-zero when any scenario
// fails. Without this guarantee, the post-deploy-smoke step in cloudbuild
// would silently pass for broken deploys, defeating the entire point of
// having a smoke gate + auto-rollback.

import { readFileSync } from 'fs';
import { resolve } from 'path';

// Inspect BOTH runners in the smoke image — the exit-code contract is
// what gates the auto-rollback decision in cloudbuild.yaml. If either
// runner drops it, the build silently passes for broken deploys.
const RUNNERS: Array<{ name: string; path: string }> = [
  { name: 'tr-runner.ts', path: resolve(__dirname, '..', '..', 'tools', 'agent-test-harness', 'tr-runner.ts') },
  { name: 'pb-runner.ts', path: resolve(__dirname, '..', '..', 'tools', 'agent-test-harness', 'pb-runner.ts') },
];

describe.each(RUNNERS)('C.1 — $name exit-code contract', ({ path }) => {
  const cliSource = readFileSync(path, 'utf-8');

  it('exits non-zero when any scenario fails', () => {
    expect(cliSource).toMatch(/process\.exit\(failed\s*===\s*0\s*\?\s*0\s*:\s*1\)/);
  });

  it('still exits 0 when all scenarios pass (so green deploys don\'t rollback)', () => {
    expect(cliSource).toMatch(/exit\([^)]*0[^)]*\)/);
  });

  it('exits 2 when called with bad args (so misconfigured cloudbuild fails loudly)', () => {
    expect(cliSource).toMatch(/process\.exit\(2\)/);
  });
});

// C.1 — Meta-test: Dockerfile.smoke must include the rollback script so
// the auto-rollback step can find it at /smoke/tools/smoke-rollback.sh.
describe('C.1 — Dockerfile.smoke wiring', () => {
  const dockerfile = readFileSync(
    resolve(__dirname, '..', '..', 'Dockerfile.smoke'),
    'utf-8',
  );

  it('copies the smoke-rollback.sh helper into the image', () => {
    expect(dockerfile).toMatch(/COPY\s+tools\/agent-test-harness\/smoke-rollback\.sh/);
  });

  it('makes the rollback script executable', () => {
    expect(dockerfile).toMatch(/chmod\s+\+x\s+\.\/tools\/smoke-rollback\.sh/);
  });

  it('runs the unified smoke-entrypoint.sh as the default entrypoint (mode dispatcher)', () => {
    // C1-1 fix: the image now ships both tr-runner.ts + pb-runner.ts and
    // dispatches via smoke-entrypoint.sh --mode=tr|pb. Pin that contract.
    expect(dockerfile).toMatch(/ENTRYPOINT\s*\[\s*"\/smoke\/tools\/agent-test-harness\/smoke-entrypoint\.sh"\s*\]/);
  });

  it('ships both the TR and PB runners so the image is reusable for both repos', () => {
    expect(dockerfile).toMatch(/COPY\s+tools\/agent-test-harness/);
    // The runners themselves should exist on disk in the build context.
    // (We can only inspect what the Dockerfile says here — the runner
    // files are checked by Dockerfile.smoke build itself in CI.)
  });
});
