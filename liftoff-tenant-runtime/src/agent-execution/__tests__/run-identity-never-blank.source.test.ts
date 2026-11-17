// A run's workflow and task ids are a well-formed uuid or absent — never an
// empty string.
//
// Both feed uuid columns, which reject a blank outright, and the places that
// build or rebuild a context are many: every pause writer, every resume
// primitive, every Cloud Tasks receiver branch, and a handful of one-off
// callers. A blank defaulted at any one of them travels to the write as a
// type error. This test walks `src/` and fails on either form of the defect —
// a `?? ''` fallback or a literal `''` — so the rule holds everywhere at once
// instead of being re-fixed one site at a time.
//
// Absence is expressed by leaving the field out (the types are optional), and
// a value that may be blank is passed through `firstPresentId` / `uuidOrNull`
// from `run-identity.ts`, which is the one place the rule is implemented.

import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const SRC = join(__dirname, '..', '..');

/** Sites deliberately left alone, each with the reason it is not a defect. */
const ALLOWLIST: ReadonlyArray<{ file: string; contains: string; reason: string }> = [
  {
    file: 'coordinator/service.ts',
    contains: "parentTaskId, workflowId: '', agentId: parent.agent_id",
    reason:
      'ExecuteTaskGraphInput.workflowId is the delegation task-graph identity, a separate '
      + 'subsystem with its own row model (insertChildTaskRow); rewiring it is its own change.',
  },
];

const OFFENDERS = [
  // `workflowId: something ?? ''` / `taskId: something ?? ''`
  /\b(workflowId|taskId):\s*[^,\n}]*\?\?\s*''/g,
  // literal `workflowId: ''` / `taskId: ''`
  /\b(workflowId|taskId):\s*''/g,
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === '__tests__' || name === 'node_modules') continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
  }
  return out;
}

describe('a run id is a uuid or absent, never a blank', () => {
  const files = walk(SRC);

  it('scans a meaningful corpus', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('finds no `?? \'\'` fallback and no literal \'\' for workflowId/taskId outside the allowlist', () => {
    const findings: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const rel = relative(SRC, file);
      for (const re of OFFENDERS) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(text)) !== null) {
          const line = text.slice(0, m.index).split('\n').length;
          const lineText = text.split('\n')[line - 1] ?? '';
          const allowed = ALLOWLIST.some((a) => rel === a.file && lineText.includes(a.contains));
          if (!allowed) findings.push(`${rel}:${line}: ${lineText.trim()}`);
        }
      }
    }
    expect(findings).toEqual([]);
  });

  it('every allowlisted site still exists (a stale entry hides nothing)', () => {
    for (const a of ALLOWLIST) {
      const text = readFileSync(join(SRC, a.file), 'utf8');
      expect(text).toContain(a.contains);
    }
  });
});
