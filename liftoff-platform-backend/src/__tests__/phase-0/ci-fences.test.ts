/**
 * Phase 0 — CI fence tests.
 *
 * Each fence is spawned as a child process against a seeded fixture tree
 * containing known-bad files. The fence must emit the expected number of
 * hits in WARN mode and exit non-zero in FAIL mode.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const FENCE_DIR = join(REPO_ROOT, 'scripts', 'ci-fences');

function runFence(
  script: string,
  args: string[],
  env: Record<string, string> = {},
): { exitCode: number; stdout: string; stderr: string } {
  const result = spawnSync(join(FENCE_DIR, script), args, {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  });
  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function seedTree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'phase0-fence-'));
  for (const [path, content] of Object.entries(files)) {
    const abs = join(dir, path);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
  }
  return dir;
}

describe('Phase 0 — legacy-literal-fence.sh', () => {
  let seeded: string | null = null;
  afterEach(() => {
    if (seeded) {
      rmSync(seeded, { recursive: true, force: true });
      seeded = null;
    }
  });

  it('is clean on a tree with no legacy literals', () => {
    seeded = seedTree({
      'src/clean.ts': `export const x: { agentType: 'agent' } = { agentType: 'agent' };\n`,
    });
    const result = runFence('legacy-literal-fence.sh', [seeded]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('clean');
  });

  it('WARN mode: exits 0 but reports hits', () => {
    seeded = seedTree({
      'src/bad.ts': `const agent = { agentType: 'B' };\n`,
    });
    const result = runFence('legacy-literal-fence.sh', [seeded], {
      LEGACY_LITERAL_FENCE_MODE: 'warn',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('found');
    expect(result.stderr).toMatch(/agentType:.*'B'/);
  });

  it('FAIL mode: exits 1 when hits are present', () => {
    seeded = seedTree({
      'src/bad.ts': `const agent = { agentType: 'C' };\n`,
    });
    const result = runFence('legacy-literal-fence.sh', [seeded], {
      LEGACY_LITERAL_FENCE_MODE: 'fail',
    });
    expect(result.exitCode).toBe(1);
  });

  it('skips whitelisted paths (migrations)', () => {
    seeded = seedTree({
      'migrations/086_collapse.sql': `UPDATE internal_agents SET agent_type = 'agent' WHERE agent_type = 'B';\n`,
    });
    const result = runFence('legacy-literal-fence.sh', [seeded], {
      LEGACY_LITERAL_FENCE_MODE: 'fail',
    });
    expect(result.exitCode).toBe(0);
  });
});

describe('Phase 0 — workflow-step-case-fence.sh', () => {
  let seeded: string | null = null;
  afterEach(() => {
    if (seeded) {
      rmSync(seeded, { recursive: true, force: true });
      seeded = null;
    }
  });

  it('is clean on a tree with no WorkflowStep-referencing files', () => {
    seeded = seedTree({
      'src/unrelated.ts': `const row = { tool_name: 'foo' };\n`,
    });
    const result = runFence('workflow-step-case-fence.sh', [seeded]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('clean');
  });

  it('ignores DB row mapping in files that do not import WorkflowStep', () => {
    seeded = seedTree({
      'src/db.ts': `
        export function mapRow(row: { tool_name: string }) {
          return { toolName: row.tool_name };
        }
      `,
    });
    const result = runFence('workflow-step-case-fence.sh', [seeded], {
      WORKFLOW_STEP_CASE_FENCE_MODE: 'fail',
    });
    expect(result.exitCode).toBe(0);
  });

  it('flags snake_case fields in files that import WorkflowStep', () => {
    seeded = seedTree({
      'src/bad.ts': `
        import { WorkflowStep } from '@liftoffos/shared-types';
        const step: WorkflowStep = { step_id: 's1', description: 'x' } as any;
      `,
    });
    const result = runFence('workflow-step-case-fence.sh', [seeded], {
      WORKFLOW_STEP_CASE_FENCE_MODE: 'warn',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toMatch(/step_id/);
  });

  it('FAIL mode: exits 1 when WorkflowStep-context hits are present', () => {
    seeded = seedTree({
      'src/bad.ts': `
        import type { WorkflowStep } from '@liftoffos/shared-types';
        const s: WorkflowStep = { step_id: 's1', description: 'x' } as any;
      `,
    });
    const result = runFence('workflow-step-case-fence.sh', [seeded], {
      WORKFLOW_STEP_CASE_FENCE_MODE: 'fail',
    });
    expect(result.exitCode).toBe(1);
  });
});

describe('Phase 0 — shared-types-drift-fence.sh', () => {
  let seeded: string | null = null;
  afterEach(() => {
    if (seeded) {
      rmSync(seeded, { recursive: true, force: true });
      seeded = null;
    }
  });

  it('is clean on a tree with no local duplicates', () => {
    seeded = seedTree({
      'src/good.ts': `import type { AgentType } from '@liftoffos/shared-types';\nconst x: AgentType = 'agent';\n`,
    });
    const result = runFence('shared-types-drift-fence.sh', [seeded]);
    expect(result.exitCode).toBe(0);
  });

  it('flags a local duplicate of AgentType', () => {
    seeded = seedTree({
      'src/bad.ts': `export type AgentType = 'A' | 'B' | 'C';\n`,
    });
    const result = runFence('shared-types-drift-fence.sh', [seeded], {
      SHARED_TYPES_DRIFT_FENCE_MODE: 'warn',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toMatch(/AgentType/);
  });

  it('flags a local duplicate of WorkflowStep', () => {
    seeded = seedTree({
      'src/bad.ts': `export interface WorkflowStep { stepId: string; }\n`,
    });
    const result = runFence('shared-types-drift-fence.sh', [seeded], {
      SHARED_TYPES_DRIFT_FENCE_MODE: 'fail',
    });
    expect(result.exitCode).toBe(1);
  });
});
